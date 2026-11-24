# dsh-delete-guard

[English](README.en.md) | **简体中文** | [日本語](README.ja.md)

拦截模型发出的删除命令，改为移入 Windows 回收站。

```
agent:  Remove-Item -Recurse -Force .\src
被拒:    The delete guard blocked this delete. Re-run this as: file_trash with paths = ["…\src"]
随后:    file_trash → 移入回收站，「还原」可用
```

```
agent:  $lines=Get-Content $f; $idx=(…Select-String…).LineNumber; Set-Content $f $lines[0..($idx-2)]
被拒:    …`$idx` is offset by arithmetic in a slice endpoint, it is never checked for $null…
        Fix, then re-run:  if (-not $idx) { throw "anchor not found" }
```

## 解决什么问题

DSH 里模型执行 `pwsh` 的删除命令，文件是被直接抹掉的：`ctx.fs` 没有 delete，
`ctx.shell` 只有 `execute()`，没有任何中间层。一句 `Remove-Item -Recurse -Force`
就能带走一整个目录，没有回收站，没有撤销。

本插件挂在 `tools/pre-execute`（宿主路由每个工具调用的接缝），把这些调用拒绝，
并告诉模型改用 `file_trash`；后者用 `SHFileOperationW(FOF_ALLOWUNDO)` 移动文件——和资源
管理器删文件是同一套 Win32 API，所以 `$Recycle.Bin` 的 `$I`/`$R` 元数据正确，「还原」可用。

挡住的不只是 `Remove-Item`：管道、`xargs`、变量拼接的目标、写在 `if { }` 里的删除、内联
`-Command` / `-EncodedCommand`、持久终端里敲的命令、Git Bash 的 `/c/...` 路径、以及清空
回收站的各种写法，各有对应规则。

还有一类没有删除动词的毁灭：把文件读进来、算一刀、再覆盖回同一个文件。
`$lines[0..($null-2)]` 在 PowerShell 里不是错误，而是 `$lines[0..-2]`，即「首行 + 末两行」
——一个 605 行的文件可以这样被静默写成 24 行。这类命令不能进回收站（网络共享上没有），
也不会被事后比对发现，所以在写入前就按「读改写同一文件」和「未断言的切片端点」拒绝。

## 安装

```shell
# 从 npm 安装
dsh plugin --profile web add dsh-delete-guard
# 或直接从仓库安装（npm 不可用时）
dsh plugin --profile web add github:deepestevan/dsh-delete-guard
# 或者从本地 tarball（改过源码时用这条）
pnpm pack --pack-destination ./temp/pack     # 先升 package.json 的 version
dsh plugin --profile web add file:./temp/pack/dsh-delete-guard-2.4.2.tgz
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
| **读改写同一个文件** | `(Get-Content $f) \| Set-Content $f`、`$c = Get-Content $f; Set-Content $f $c`、`sed -i $f`、`cat $f > $f`、`::ReadAllText` → `::WriteAllText`——新内容来自唯一的副本。先备份到 `.bak`，或写临时文件校验后再换上去的写法放行 |
| **未断言的切片端点** | 同一命令里既写文件、又用 `$idx ± n` 当区间端点（`$l[0..($idx-2)]`、`-First ($i-1)`），而 `$idx` 从没检查过 `$null`。`$null` 在 PowerShell 里不报错：`0..($null-2)` 就是 `0..-2` = 首行 + 末两行 |
| **读动词折进写语句里** | `Set-Content $f (Get-Content $f \| Select-Object -First 10)`：一行里既读、又截断、又写回 |
| **经变量调用的 shell** | `$shellPath='…bash.exe'; & $shellPath -c "rm -rf …"`：程序名不是字面量，正文无法判定 |

**放行**：只读命令、只提到删除词的操作（`Select-String -Pattern "Remove-Item"`、
`Get-Content shred.exe`）、从回收站**还原**文件、`Add-Content` / `>>` / `-Append`
（追加不替换）、写 `$null` / `/dev/null`，以及带备份或校验步骤的整档重写。
`node -e` / `python -c` 体里**提到**擦除工具名的文本不算程序名——只有把它交给
`exec` / `execSync` / `spawn` / `system` / `subprocess.*` 才算（`bash -c` 体是 shell 文本，仍按整段判）。

## 两个工具

| 工具 | 作用 |
| --- | --- |
| `file_trash { paths, reason? }` | 唯一允许的删除方式。本地条目移入回收站；共享条目先复制到本地卷、校验、回收副本，之后才删原件（见「网络共享」）。逐条报告成功与失败 |
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
| `blockTruncatingWrites` | `true` | 禁止「读改写同一文件」与「未断言的切片端点 + 写文件」 |
| `uncRecoverableMove` | `true` | 共享删除：先复制到本地 NTFS 卷 + 校验 + 回收副本，再删原件；`false` 则纯拒绝 |
| `stagingRoot` | `%LOCALAPPDATA%\dsh-delete-guard\staging` | 共享删除的暂存目录（必须在有回收站的本地卷上） |

## 恢复已删的文件

恢复由操作系统的回收站完成。脚本里这样还原（与界面语言无关）：

1. 读 `X:\$Recycle.Bin\<SID>\$I*` 记录：偏移 24 是原路径字符数，偏移 28 起是 UTF-16LE 原路径；
2. 按原路径匹配到目标条目，取配对的 `$R` 文件；
3. `Move-Item` 搬回原位。

`$R`/`$I` 的文件名是随机的（`$R3LCXYR.txt`），原文件名不在文件名里，只能靠解析 `$I`
反查；动词还原后可能残留孤儿 `$I` 记录，跳过 payload 缺失的即可。资源管理器里右键
「还原」与之一致，只是脚本化时别依赖本地化的动词名。

## 网络共享（没有回收站）

UNC 路径下不存在回收站：`SHFileOperationW` 在那里是擦除并返回成功，所以桥接会先拒绝。
`file_trash` 于是按固定顺序处理，一次调用完成：

1. 把条目复制到有回收站的本地 NTFS 卷（`%LOCALAPPDATA%\dsh-delete-guard\staging\<时间戳>-<名字>`，可用 `stagingRoot` 改）；
2. 对照原件校验：相对路径集合、条目类型、每个文件的大小；
3. 把暂存目录送进回收站——副本这时可还原；
4. 最后才删除原件。

可恢复的是**内容**（在本地回收站里），不是**原路径**：共享上没有回收站放它，第 4 步就是一次
普通永久删除。因此第 4 步之前的任何失败都不碰原件，而第 4 步只在桥接确认暂存副本已进回收站
之后才执行。

还原时落点是暂存路径而不是原共享路径（回收站的 `$I` 记的是暂存位置），工具会把该路径打出来。

以下情况在复制之前就被拒绝：共享根（`\\host\share`）与只有主机名的形态、树里含重解析点
（junction／符号链接：复制要么把目标内容一起复制进来、要么需要权限重建链接）、暂存卷空间不足。

`uncRecoverableMove: false` 时改为直接拒绝共享路径，不复制也不删除。

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
| **没读过就覆盖**（`echo x > 既有文件.md`、`Invoke-WebRequest -OutFile $f`、`git checkout -- f`） | 新内容不依赖旧内容，不是读改写 |
| 读改写里的**间接**写（编译器、`npm run build`、`robocopy` 覆盖产物） | 写入发生在子进程内部，命令文本里没有可判定的目标 |
| 写完之后按体积判断有没有被截断 | 回滚需要覆盖前的旧内容，而 `tools/post-execute` 只能把结果改成反馈 |
| 把共享上的东西 `Move-Item` / `robocopy /MOV` 到本地 | 内容到了目标位置，但共享上的原件被永久删除，没有回收站记录 |
| **内含非法名字的目录**（名字以空格或点结尾，再由 WSL、解压工具或同步客户端留下） | Win32 写到路径里会截掉尾随的空格/点，所以目录树走不完。工具会指出是哪个条目、为什么，但**不替你改名或删除** |
| **被进程占用的目录**（工作目录设在里面，或里面某个文件开着） | 里面的文件可以逐个删，目录本身要等占用释放。工具会说这是占用，但**不去查是哪个进程**——那需要提权或枚举句柄，猜一个 PID 比不给更糟 |

覆盖的 shell 工具名：`pwsh`、`powershell`、`cmd`、`bash`、`sh`、`zsh`、`shell`、
`terminal_send`、`terminal_write`。

## 测试

```shell
node test/run-all.mjs
```

155 项、十层：命令分类（50）、覆盖守卫（30）、规则漏洞（12）、暂存删除（8）、`file_trash` 操作数守卫（15）、
宿主 schema 与钩子接线（14）、宿主 schema 受理（5）、对真实回收站的端到端（14，含真 `\\localhost\C$` 路径）、
失败诊断（7）。
`test/` 不进 tarball，所以打包前必须全绿；其中两层会加载宿主自己的校验器，找不到 DSH 安装时报「跳过」而非失败。
另有一层文档检查（`scripts/verify-readme-structure.mjs`）：三份 README 的章节数与表格行数必须一致。

## 文档

| 文件 | 内容 |
| --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | 每个版本改了什么、为什么 |
| [SECURITY.md](SECURITY.md) | 威胁模型：策略层，不是沙箱 |
| [docs/incidents/](docs/incidents/) | 规则的实测依据与逐字命令（不进 npm 包） |
| [LICENSE](LICENSE) | MIT |

## 许可

MIT，见 [LICENSE](LICENSE)。
