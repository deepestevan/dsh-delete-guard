# dsh-delete-guard

[English](README.en.md) | **简体中文** | [日本語](README.ja.md)

**让 agent 删不掉「恢复不了」的东西。**

删除只有两条路：进 Windows 回收站（资源管理器里能还原），或者被拦下来换成一次
`file_trash` 调用。没有第三条。

```
agent:  Remove-Item -Recurse -Force .\src
被拒:    The delete guard blocked this delete. Re-run this as: file_trash with paths = ["…\src"]
随后:    file_trash → 移入回收站，「还原」可用
```

## 解决什么问题

DSH 里模型执行 `pwsh` 的删除命令，文件是被直接抹掉的：`ctx.fs` 没有 delete，
`ctx.shell` 只有 `execute()`，没有任何中间层。一句 `Remove-Item -Recurse -Force`
就能带走一整个目录，没有回收站，没有撤销。

本插件挂在 `tools/pre-execute`（宿主真正路由每个工具调用的接缝），把这些调用**拒绝**，
并告诉模型改用 `file_trash`；后者用 `SHFileOperationW(FOF_ALLOWUNDO)` 移动文件——和资源
管理器删文件是同一套 Win32 API，所以 `$Recycle.Bin` 的 `$I`/`$R` 元数据正确，「还原」可用。

挡住的不只是 `Remove-Item`：管道、`xargs`、变量拼接的目标、写在 `if { }` 里的删除、内联
`-Command` / `-EncodedCommand`、持久终端里敲的命令、Git Bash 的 `/c/...` 路径、以及清空
回收站的各种写法，各有对应规则。

## 安装

```shell
# 从 npm 安装
dsh plugin --profile web add dsh-delete-guard
# 或直接从仓库安装（npm 不可用时）
dsh plugin --profile web add github:deepestevan/dsh-delete-guard
# 或者从本地 tarball（改过源码时用这条）
pnpm pack --pack-destination ./temp/pack     # 先升 package.json 的 version
dsh plugin --profile web add file:./temp/pack/dsh-delete-guard-2.2.2.tgz
# 重启 dsh web：lib/*.js 只在进程启动时加载
```

`file:` 必须指向 tarball，不能指向源码目录——目录形式 pnpm 会硬链接，源码一挪插件就悬空。

更新走 `remove` + `add` 两步：单跑 `add` 可能返回 `Already up to date` 而什么都没换，而 `lib/*.js` 只有进程重启才会重新加载。

## 挡住什么

**会进回收站（被重定向）**

```
Remove-Item C:\tmp\a.txt        del / erase / rd / rmdir / rm / unlink
Remove-Item -Recurse -Force C:\tmp\dir
if (Test-Path $p) { Remove-Item $p -Force }
terminal_send: "Remove-Item C:\tmp\a.txt"
```

**直接拒绝**

| 类别 | 例子 |
| --- | --- |
| 目标不可枚举（没法证明搬对东西） | `Remove-Item $(…)`、`… \| Remove-Item`、`xargs rm`、`Remove-Item @targets`、`-Recurse C:\tmp\*` |
| 危险路径 | `C:\`、`\`、`C:\Windows`、`Program Files`、`..\..\`、Git Bash 的 `~` / `/tmp` |
| 无删除动词的擦除 | `[System.IO.File]::Delete(…)`、`Invoke-Expression "…"`、`cmd /c del`、`robocopy /MIR`、`find -delete` |
| 永久擦除工具 | `shred`、`sdelete`、`srm`、`cipher /w`、`format X:`（只按程序位置判定） |
| 清空回收站 | `Clear-RecycleBin`（含 `&`、子壳、`-EncodedCommand` 形态）、`SHEmptyRecycleBin`、对回收站条目驱动 shell 动词、直接删 `$Recycle.Bin` 内容 |
| 没有回收站的位置 | UNC 共享、exFAT/FAT32 卷（在那里"回收"等于永久擦除） |
| 脚本内删除 | 内联 shell / Python / Node 体里的删除动词与擦除调用；把含删除的文本写进 `.ps1`/`.sh`/`.py` |

**放行**：只读命令、只提到删除词的操作（`Select-String -Pattern "Remove-Item"`、
`Get-Content shred.exe`）、以及从回收站**还原**文件。

## 两个工具

| 工具 | 作用 |
| --- | --- |
| `file_trash { paths, reason? }` | 唯一允许的删除方式。移入回收站，逐条报告成功与失败，绝不降级成永久删除 |
| `trash_status { drive? }` | 报告该卷回收站的项目数与占用，用于确认删除确实落进了回收站 |

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（`config` 是整块替换，要保留的键必须重述）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `blockDestructiveCommands` | `true` | 拦截 shell 删除并重定向到 `file_trash` |
| `forbidEmptyRecycleBin` | `true` | 禁止清空或改动回收站 |
| `forbidWipe` | `true` | 禁止 `shred` / `sdelete` / `srm` / `cipher /w` / `format` |
| `blockScriptDeletes` | `true` | 禁止脚本文件与内联字符串里的删除 |

## 恢复已删的文件

恢复不是插件的功能，也不需要——回收站是操作系统的。脚本里这样还原（与界面语言无关）：

1. 读 `X:\$Recycle.Bin\<SID>\$I*` 记录：偏移 24 是原路径字符数，偏移 28 起是 UTF-16LE 原路径；
2. 按原路径匹配到目标条目，取配对的 `$R` 文件；
3. `Move-Item` 搬回原位。

`$R`/`$I` 的文件名是随机的（`$R3LCXYR.txt`），原文件名不在文件名里，只能靠解析 `$I`
反查；动词还原后可能残留孤儿 `$I` 记录，跳过 payload 缺失的即可。资源管理器里右键
「还原」与之一致，只是脚本化时别依赖本地化的动词名。

## 不挡什么

| 不覆盖 | 原因 |
| --- | --- |
| 脚本文件里已有的删除（守卫从未见过内容） | 只能拒绝写入与看得见的内联形态，不能执行期改写 |
| `Add-Type` 里写任意 C#（如 `DeleteFileW`） | 文本判定够不到；只有针对回收站的 API 被点名拦掉 |
| 命令名先拼进变量再 `& $c` 调用 | 文本层面无法求值 |
| 表格外工具名的执行通道（自定义 shell 工具、第三方插件） | 覆盖名单是显式的，见下 |
| 终端里分两次发送才拼出的删除 | 每次 send 只看到这一次的文本 |
| 非 Windows 平台 | 桥接是 `SHFileOperationW` |
| 空余空间不足时的删除 | NTFS 同卷回收是 rename，不占新空间，没有可预检的东西 |

覆盖的 shell 工具名：`pwsh`、`powershell`、`cmd`、`bash`、`sh`、`zsh`、`shell`、
`terminal_send`、`terminal_write`。判定看的是语句的命令词、调用的形态和程序位置，不是「这一行里出现过这个词」。

## 测试

```shell
node test/run-all.mjs
```

90 项、五层：命令分类（49）、`file_trash` 操作数守卫（15）、宿主 schema 与钩子接线（11）、
宿主 schema 受理（5）、对真实回收站的端到端（10）。`test/` 不进 tarball，所以打包前必须
全绿；其中两层会加载宿主自己的校验器，找不到 DSH 安装时报「跳过」而非失败。

## 文档

| 文件 | 内容 |
| --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | 版本摘要 |
| [SECURITY.md](SECURITY.md) | 威胁模型：策略层，不是沙箱 |
| [LICENSE](LICENSE) | MIT |

设计取舍、逐轮实测与发布跑批属于工程笔记，保存在维护者侧，不随仓库与包发布。

## 许可

MIT，见 [LICENSE](LICENSE)。
