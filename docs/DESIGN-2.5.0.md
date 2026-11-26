# 2.5.0 设计草案（2026-11-26）

**主题**：把判据的作用域从"整条命令文本"收敛到"被判的那个对象"。2.4.5 已经把**豁免**绑到目标文件
（备份、有界替换、编码），2.5.0 做的是同一件事的另一半：**规则触发面**也按语句、按文件、按语言收窄。

这不是一次"放松"，而是把 2.4.5 里仍然按整条命令求值的地方逐个换成按对象求值。每一项都对应
当前 6,000 条真实命令样本里**确实被误拒**的形态；没有样本支撑的不做。

**前提**：先把 2.4.5 落进一次提交。现在整棵树（含 `docs/incidents/` → `docs/archive/` 的迁移和
三份 review）都未提交，2.5.0 的改动一旦混进去就无法归因。提交不等于发布（AGENTS §6.7）。

---

## 1. 证据：当前样本里还剩哪些误拒

`temp/cmd-sample.json`，6,000 条，2.4.5 工作树，`deny` 70 条（1.17%）。按形态归类：

| 形态 | 条数 | 归类 |
| --- | --- | --- |
| 命令里出现过循环，于是"写后读"豁免被整条命令关掉 | 51 条 in-place 中 14 条带备份/临时文件标记，其中 4 条可确认为"写→读校验" | 误拒（D1） |
| `$( … )` 出现在与删除无关的语句里 | 7 条 opaque 中 4 条 | 误拒（D2） |
| 删除操作数是变量，而同一条命令里已有字面量绑定（含 `foreach` 数组） | 3 条 opaque（样本里"绑定后删除"共 4 条，全部被拒） | 误拒（D3） |
| 切片端点出现在 here-doc 正文（commit message）里 | 3 条 slice-risk 中 1 条 | 误拒（D4） |
| `2>$null` 被算成"写文件"，于是切片规则开火 | 3 条 slice-risk 中 1 条 | 误拒（D4） |
| 写 `.py`/`.js` 脚本被 shell 动词表判（`del d['a']` 算删除，`os.remove` 不算） | 1 条 script | 误拒（D5/D6） |
| 真切片 + 读改写同一文件 | 1 条 | 应拒，保留 |

另外两处是**文案缺陷**（不是判定）：opaque 理由里写的是字面 `$name` 而不是实际变量名；
`-WhatIf` 的混合语句说 "nothing was executed"，但只有一部分语句是 dry run。

---

## 2. 设计项

### D1 循环作用域

**现在**：命令里只要出现 `for`/`foreach`/`while`/`do`/`switch`/`%`/`ForEach-Object`，整条命令的
"读在写之后 → 是校验"豁免关闭。实测代价：`foreach (…) { … }; Set-Content $tmp …; Get-Content $tmp`
这种"先循环、再写临时文件、再回读校验"被当成读改写。

**改为**：给每条语句标注花括号深度与所属循环区间；只有当**同一文件**的写与读落在**同一个循环体**里时
才关闭豁免（那才是"顺序不可信"的情形）。

**仍拒**：`for { Set-Content f …; $c = Get-Content f }`（同体，读可能来自下一轮）、
读在写之前、以及 `while`/`switch` 同体形态。

**测试**：`$tmp` 写→读→覆盖原文件（放行）、同体写后读（拒）、循环内读后写（拒）、
`Get-ChildItem | % { Set-Content $_.FullName … }`（保持现状：不触发，因为 `$_` 不产生比较键）。

### D2 `$( … )` 与反引号的作用域

**现在**：`OPAQUE_CONSTRUCTS` 对**整条命令**求值；命令里任何一处 `$( … )` 加上任何一处删除 → 拒。
实测代价：`Write-Output "at $(Get-Date)"; Remove-Item a.txt` 这类命令被拒，而且理由说"target set 无法证明"，
与实际的 `a.txt` 无关。

**改为**：只在**删除语句自身**里判这个构造。三条兜底不变：
`Remove-Item $(…)`（操作数里的 `$( )`，`SUBSTITUTION_IN_TARGET`）、`… | Remove-Item`（管道删除规则）、
`$x = $(…); Remove-Item $x`（操作数是变量 → D3 代入失败后仍拒）。

**仍拒**：`Get-ChildItem $(…) | Remove-Item`（上游构造 + 管道删除）。

**终端（ambiguous）合并规则不改**：反引号在 pwsh 是转义、在 bash 是替换，合并时 bash 侧没有 targets
可比，取 rewrite 会把 bash 里 `` `cat list.txt` `` 的目标改写成 `cat list.txt` —— 错的文件。
维持拒绝，只保留 2.4.5 已改好的文案。

### D3 删除操作数的字面量代入

**现在**：操作数是 `$x` / `${x}` → `opaque`，理由写死 `$name`。实测代价：`$log='…'; if (Test-Path $log)
{ Remove-Item -LiteralPath $log -Force }` 被拒，模型只能改写成字面路径再删一次。

**改为**：复用 `rewrite-guard.js` 的按语句字面量表（2.4.5 已按语句解析）。操作数**恰好**是变量、
且该变量在**这条删除语句之前**有唯一字面量绑定 → 代入，然后走同一套检查（provider、根路径、
通配符、`..`）。代入不出来（无绑定 / 多次绑定 / 绑定值是表达式）→ 维持拒绝。

**扩展（同一族）**：`foreach ($f in @('a','b')) { Remove-Item $f }` —— 循环变量绑定到**数组字面量**时
逐个展开。只认数组字面量，不认 `Get-ChildItem` 之类的运行期集合。

**仍拒**：代入后命中 `FORBIDDEN_TARGETS`（盘根、Windows、Program Files、`..`）、含通配符、
或绑定值本身含变量/命令替换。

**顺带**：理由里写实际变量名（`$p`），不是 `$name`。

### D4 here-string 正文按数据处理

**现在**：`uncheckedSlice` 在原始命令上找切片端点，于是 commit message 里引用的 `$lines[0..($idx-2)]`
被当成真的切片；`writtenTargets` 把 `2>$null` 算作写文件，于是只读命令也能触发切片规则。

**改为**：(a) 切片扫描用 `maskHereStrings(command)`（与 2.4.5 的 here-string 处理同一套：
已赋值的 here-string 是数据，交给解释器的仍按程序判）；(b) `writes` 判定忽略 `$null` / `NUL` / `/dev/null`。

**仍拒**：真的"读文件 → 切片 → 写回同一文件"。

### D5 脚本写入按扩展名分表

**现在**：一张 shell 动词表扫所有扩展名 —— `.py` 里的 `del d['a']` 算删除，`os.remove` 不算；
`.js` 里的 `fs.rmSync` 不算、`fs.rm(` 算。

**改为**：

| 扩展名 | 判据 |
| --- | --- |
| `.ps1` `.psm1` `.bat` `.cmd` `.sh` `.bash` `.zsh` | 现有 shell 动词表（这个表对 shell 是精确的） |
| `.py` | `os.remove` / `os.unlink` / `os.rmdir`、`shutil.rmtree`、`pathlib…unlink`、`os.system`、`subprocess.*`；`del` 不再算 |
| `.js` `.mjs` `.cjs` `.ts` | `fs.rm` / `fs.rmSync` / `fs.unlink` / `fs.rmdir`（含 `fs.promises.*`）、`rimraf`、`child_process.execSync` |
| 其他 | 不适用（写 `.md` 提到 `rm -rf` 不应被拒） |

### D6 写脚本与执行脚本的边界（**需要你裁的一项**）

**现在**：把含删除的文本写进脚本文件就被拒。

- **方案 A（推荐）**：shell 脚本（`.ps1`/`.sh`/`.bat`）维持拒绝；`.py`/`.js`/`.ts` 的写入放行，
  **除非同一条命令里又执行了它**（`python x.py`、`node x.js`、`… | python`、`… | iex`）。
  理由：写不是执行；`.py`/`.js` 的动词表本来就是近似的，为它拒掉写测试/清理脚本，代价高而收益低。
- **方案 B**：维持现状，只做 D5 的词表修正。

两者都不改变已经写进 `SECURITY.md` 的缺口："脚本文件里已有的删除，守卫看不到"。
差别只在"守卫是否为一次**尚未发生**的执行预先拒绝一次写入"。

### D7 slice-risk 的目标条件

**现在**：命令里任一处写文件 + 任一处未断言端点 → 拒。实测代价：写**全新**输出文件也算。
**改为**：只在"切片所在的写入目标，也是本命令读取过的文件"时拒（即 in-place 形态）。
**仍拒**：事故形态本身（`Get-Content $f` → `$lines[0..($idx-2)]` → `Set-Content $f`）。
**风险**：把切片结果写到新文件放行——这正是要的；若那条命令同时覆盖了原文件，in-place 规则会先拒。

### D8 配置拆键与文案

- 新键 `blockInPlaceRewrite`、`blockUncheckedSliceWrite`；`blockTruncatingWrites` 保留为兼容键：
  显式写了新键就以新键为准，否则继承旧键的值（profile 里写了 `blockTruncatingWrites: false`
  的人不会突然被重新打开）。
- opaque 理由写实际变量名。
- `-WhatIf` 的混合语句不再断言"什么也没执行"；按语句说明哪些是预览。

---

## 3. 不做 / 推迟

| 项 | 原因 |
| --- | --- |
| PowerShell AST（`Parser.ParseInput`） | 每条命令 spawn 一次 pwsh（~300 ms），与 `tools/pre-execute` 的成本预算冲突；cmd/bash 各有语义，AST 只解决其中一种 |
| 映射网络驱动器暂存 | 共享没有回收站；映射盘暂存要先复制到本地，等于新增一条"拷贝整份共享再删"的路径，需要单独设计 |
| 回收站容量预检 | 需要先算树大小（O(size)）；现在由"记录证明 + 如实报失败"兜底 |
| `sed -i` 的锚定模式（`s/^/> /`） | 只放行核内还有字面文本的模式；插入型替换收益低 |
| 终端反引号合并 | 见 D2：两个方言的 targets 不可比，取 rewrite 会改错文件 |

---

## 4. 验收

**形态门（硬，任一不过就不算完成）**

- 放行集里不得出现"读同一文件 → 写同一文件"的命令（除已有备份/编码/有界替换三类豁免）。
- 代入后的目标不得命中根路径、Windows、Program Files、`$Recycle.Bin`。
- 每条放宽都配一条**必须仍拒**的近邻用例（2.4.4 起的 `escapes.test.mjs` 就是这个结构）。

**数字（软，用 6,000 条样本）**

| 指标 | 现在 | 目标 |
| --- | --- | --- |
| deny 总数（pwsh） | 70 | ≤ 55 |
| `in-place-rewrite` | 51 | ≤ 38 |
| `opaque` | 7 | ≤ 2 |
| `slice-risk` | 3 | ≤ 1（只留真切片） |

**回归**：605 行事故形态、`echo x > f`、备份写在覆盖之后、跨文件洗白（T2）、
`utf8`→`ascii`（U1）、`\\?\` 前缀、`git clean`/`reset`、空内容覆盖。

---

## 5. 实施顺序与提交边界

1. **提交 2.4.5**（含文档迁移、三份 review、triage 记录）。
2. D4（纯缺陷，最小）→ D1 → D2 → D3 → D7 → D5 → D6 → D8，每项一次提交、各自带测试。
3. 每步跑 `node test/run-all.mjs` 与 6,000 条样本的形态门；deny 数只作为观察值，不作为通过条件。
4. 全部完成后 `pnpm pack` + `remove`/`add`，按 §6.7 停在"待发布"，等你的试用意见。
