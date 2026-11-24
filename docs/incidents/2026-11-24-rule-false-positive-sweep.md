# 规则误伤摸排（2026-11-24）

用今天的分类器重跑本机历史会话里**真实执行过**的 shell 命令，找 2.3.0 / 2.4.0 新规则引入的误伤。

## 方法与口径

- 数据：`~/.dsh/sessions` 全库 5,779 个 `session.v4.jsonl.zstd`（1.7 GB），跳过本对话自身。
- 抽取：每条 `tool/call`（工具属 `pwsh`/`bash`/`shell`/`terminal_send` 等），排除 `tool/result` 已带守卫拒绝的调用 → 即"当年真跑通"的命令。
- 判定：把这些命令喂给**当前** `classifyCommand`，得到"今天会不会被拒"。
- 这是**差值判定**：历史放行 + 今天拒绝 = 回归。

## 总量

| 项 | 值 |
|---|---|
| 扫描日志 | 5,746 |
| 实际执行过的 shell 命令 | **62,131** |
| 历史上被守卫拒过 | 134 |
| 当年放行、今天会被拒 | **1,580（2.54%）** |
| ├ 误伤（fp） | **432（0.70% of 全部命令）** |
| └ 真拦住（real） | 1,148（1.85%） |

## 误伤明细

| 类别 | 条数 | 实例 | 为什么是误伤 |
|---|---|---|---|
| `fp:point-edit` | 411 | `$t=$t.Replace('a','b'); [IO.File]::WriteAllText($p,$t)` | 定点字面量替换，等价 `edit` 工具 |
| `fp:dry-run` | 7 | `Clear-RecycleBin -Force -WhatIf` | 干跑，不执行 |
| `fp:temp-then-verify` | 4 | 写 `.tmp` → 校验 → `Copy-Item` 覆盖 | **正是拒绝消息自己教的配方** |
| `fp:probe` | 4 | `Get-Command shred,…`、`Delete('does-not-exist')` | 只探测，或路径不存在 |
| `fp:restore` | 3 | `Verbs()` 找 `*还原*` 再 `DoIt()` | 还原，README 明写允许 |
| `fp:asserted-slice` | 2 | 已 `if (-not $idx) { throw }` | 断言未被识别 |
| `fp:read-bin` | 1 | `Namespace(10).Items()` 只列举 | 纯只读 |

## 两份逐条审计（由冷启动子代理独立完成）

### `in-place-rewrite` 400 条（`temp/audit-inplace-rewrite.md`）

| 判定 | 条数 | 占比 |
|---|---|---|
| NECESSARY | 9 | 2.3% |
| FALSE_POSITIVE | 383 | 95.8% |
| UNSURE | 8 | 2.0% |

误伤聚类：T1 读本条刚生成的新文件 171 / T3 定点替换 150 / T4 定点改行 38 / T2 读 A 写 B 13 / T5 区间已校验 9 / T6 只动尾部空白 2。

9 条 NECESSARY 全是「同一路径、读前已存在、切片无断言、整档重拼」——包括 id 139：`$idx = -1` 导致 `$lines[0..-1]`，正是 2026-11-14 事故的同一形态。

### `opaque` 78 条

| 判定 | 条数 | 占比 |
|---|---|---|
| NECESSARY | 8 | 10.3% |
| FALSE_POSITIVE | 70 | 89.7% |

**最硬的一条事实**：没有任何一条的删除操作数是由 `$( … )` 算出的（机检：78 条里只有 1 条 `$(` 落在删除操作数附近）。规则想拦"目标是命令替换"，实际命中的全是邻近特征：

| 簇 | 触发条件 | 条数 |
|---|---|---|
| A | `$( … )` 在输出串/判断里，与删除无关 | 21 |
| B | here-string 正文里的 `$(`（写给子脚本的代码） | 3 |
| C | 操作数是变量，但同文本内由字面量绑定 | 31 |
| D | 目标根本不是文件（`Env:`/`variable:`/无动词） | 6 |
| E | `Remove-Item` 无操作数（空转/仅重定向） | 4 |
| F | 反引号其实是 PowerShell 转义（`` `n ``） | 5 |

## 另发现的两个独立缺陷（不是误伤，是错误行为）

### 1. 拒绝理由在撒谎

`SUBSTITUTION_IN_TARGET` 判的是"操作数含 `$`"，理由却写"target is a command substitution"。机检：78 条里有 **33 条**理由说命令替换，而命令里根本没有 `$(`。模型读到的解释是错的，会按错的理由改命令。

### 2. PowerShell provider 路径被当成文件

| 命令 | 现状 | 问题 |
|---|---|---|
| `Remove-Item variable:helper` | 拒 → `file_trash("variable:helper")` | 删的是内存变量；给出的指令必然失败 |
| `Remove-Item env:MY_VAR` / `function:prompt` / `alias:ls` | 同上 | 同上 |
| `Remove-Item HKCU:\Software\Foo` / `Cert:\…` | 拒 → `file_trash("HKCU:\…")` | 回收站管不了注册表/证书库 |
| `Remove-Variable` / `clear-variable` | **放行** | 与 `Remove-Item variable:` 同义却一拦一放 |

## 结论

三条判据划线划错了，不是阈值问题：

1. **`in-place-rewrite` 把"读写同一文件"当作危险本身**。真正危险的是**内容被大面积丢弃**：区间切片、`-First/-Skip/-Last`、整档重拼。局部替换（`.Replace`）等价于 `edit`，不该进入这个判定。
   - 决定性证据：152 条 Replace 形态里只有 8 条同时读截断，而这 8 条**全部**带区间切片——危险来自切片，不来自 Replace。
2. **`opaque` 不看 `$( … )` 相对删除动词的位置**。它把四种完全不同的情形（无关位置的替换、here-string 正文、字面绑定的变量、反引号转义）并成同一个拒绝。
3. **"给出可照做的替代"这个设计目标没有兑现**：`temp-then-verify` 被拒（那正是消息里教的配方）、provider 路径被改道到 `file_trash`（必然失败）、理由与事实不符（33 条）。

## 未解决 / 待判

- `real:whole-rewrite` 里 8 条 UNSURE：写入内容由外部脚本决定（`& $py fix.py` 后写回），文本层不可判。
- `real:opaque` 保留的 8 条里，2 条（id 36、39）删的是同一命令刚用 `GetTempFileName()` 写出的临时脚本，实质无害。
- 本次只覆盖 shell 工具通道；`write`/`edit` 工具自身的整档替换不在守卫范围（设计如此）。
- 样本是单机历史，偏向本机的使用形态（大量文档改写、Python 脚本、nexttavern 项目）。绝对比例换机器会变，形态排序应可复现。
