# 三份外部 review 的核对与 2.4.5 处置（2026-11-26）

**材料**：`docs/GPT review.md`、`docs/GROK review.md`、`docs/Gemini review.html`（三份均以已发布的 2.4.4 为基线），
`docs/ORIGINAL INTENT BEFORE BUILD.txt`（作者原话：防幻觉 / TYPO / Windows 环境 / pwsh 语法不熟造成的
不可逆删除或清空——工作区被清空、整个盘被清空、文档编辑时意外清空）。

**被核对的对象不是 2.4.4，是工作树**：`package.json` 2.4.5、14 个文件未提交改动；profile 里已装的
`dsh-delete-guard` 与工作树的 `lib/`、`scripts/recycle-bin.ps1` **逐字节相同**（SHA256 前 16 位一致），
所以本文的实测结论就是这台机器上正在跑的守卫的行为。基线：`node test/run-all.mjs` 222 项全绿，
`temp/review-final-measure.mjs` 在 6,000 条真实命令上 deny 56/6000（0.93%）。

**核对方法**：只读探针驱动真实的 `classifyCommand` 与真实的 `tools/pre-execute` 钩子（不是看规则文本）；
`\\?\` 与回收结果用 live `file_trash` 在 `temp/` 自建文件上验（不碰用户文件）。探针在 `temp/`（gitignored），
未改任何 tracked 文件。

---

## 1. 结论

1. **三份 review 各自抓到了真问题，但共同前提（"主要毛病是收得太紧"）在当前工作树上不成立。**
   偏松的一侧证据更强、后果更重：可即时演示的承诺落空有 4 处，而"误伤"侧的每一条都有一轮就能通过的出口。
2. **两份 P0 都成立，并已端到端复现**：`\\?\` 前缀绕过全部路径保护（一个 `temp` 文件被前缀形态回收进了
   F: 回收站，`$I` 记录里原路径不带前缀）；"回收成功"没有进入回收站记录的任何证据。
3. **2.4.5 的 CHANGELOG 有一行不成立**：`git clean -fd` 只在分类器里拒绝，真实钩子仍然放行。
   与 2.4.4 修过的 `[System.IO.File]::Delete` 是同一个形态——规则存在于一条永不执行的路由上。
4. **三份 review 都没看到的最严重几处都在"宽"的一侧**：预过滤漏掉 `sed -i` / `truncate` 一族，使 README
   承诺的拦截从未发生；备份/编码/有界替换三条豁免按**整条命令文本**求值（不绑定目标、不比较编码值），
   可以把 `b.md` 的整档重写洗白成 `allow`；`trash_status` 查询失败时报 0 项 0 字节。
5. 原话意图点名的三件事里，**系统目录与工作区根仍可从 `file_trash` 走通**：`\\?\C:\` 恰好被拒，但拒它的
   是"网络共享根"那条规则（`\\?\C:` 被读成 host=`?`、share=`C:`），不是盘根规则；`\\?\C:\Windows`、
   `\\?\C:\Program Files`、`\\?\C:\$Recycle.Bin`、工作区根本身全部 `ACCEPTED`。**"文档编辑时意外清空"
   仍有三条路**（空内容覆盖、`sed -i`、编码值不比较）。这两类优先于任何放宽。

---

## 2. 核对结果

### 2.1 成立且可即时演示（P0）

| # | 声明 | 证据 | 实测 |
| --- | --- | --- | --- |
| 1 | GPT P0#1：`\\?\` 前缀使 Windows / Program Files / 回收站库 / UNC 根 / 工作区根的安全检查全部失配，桥接剥前缀后回收真实路径（盘根被拒，但命中的是 UNC 规则） | `lib/move-guard.js:93`（`resolve` 保留前缀）、`:110`（`forbiddenReason` 失配）、`:145-159`（`relative()` 对前缀路径返回绝对路径）；`lib/index.js:613,618,626,641,675`；`scripts/recycle-bin.ps1:110-114,408` | live `file_trash(["\\?\F:\…\temp\p01-probe\a.txt"])` → `Moved to the Recycle Bin`；F: bin 2604→2605；`\\?\C:\Windows\System32\kernel32.dll` → `ACCEPTED` + `stat ok`（未删，仅证明检查通过）。`validateTrashTarget('\\?\C:\')` 被拒，但理由串是 "a network share root"——盘根规则并未命中 |
| 2 | GPT P0#2：回收成功 = `rc==0` ∧ 未 abort ∧ 源路径消失；无 `FOF_WANTNUKEWARNING`，无回收记录证据 | `scripts/recycle-bin.ps1:366-375`（无 0x4000）、`:377-387`、`:193`（只看 `DriveFormat`）、`:187`（只拒 `\\*` 拼法）；`lib/staging.js:271-283` | 本机 C: 回收站上限 25842 MB；默认 `stagingRoot` 在 C:（`%LOCALAPPDATA%`）。一份 >25 GiB 的共享树会被暂存到 C:，回收副本按 `FOF_ALLOWUNDO`"if possible"不产生记录，桥接只看到"路径消失"→ 报成功 → `rm` 掉共享原件。两份都没了 |
| 3 | GPT 四.1：映射网络驱动器未识别 | `lib/staging.js:61-71`（只看 `\\` 前缀）、`scripts/recycle-bin.ps1:187-195`（不看 `DriveType`） | **本机 `S:` 就是活的**：`\\DESKTOP-EPM9A2E\Share`，`DriveType=Network`、`DriveFormat=NTFS` → volume 检查通过、`isNetworkPath=false` → 直送桥接 → `SHFileOperationW` 在网络上擦除并返回 0 → 报"Moved to the Recycle Bin" |
| 4 | GPT 二.2：`Clear-Content` / `Set-Content -Value ''` / `truncate -s 0` 放行（只查切片与读改写两类） | `lib/rewrite-guard.js:1025-1037`、`:77-96`；无 fs 调用（纯文本），因此"目标是否存在"从不参与 | 10 个清空既有文档的形态在 `classifyCommand` **和 hook** 上全部 `allow`；`README.md:155` 明文把"没读过就覆盖"列为不覆盖 |

### 2.2 成立，但 2.4.5 只在分类器里成立（承诺落空）

| # | 声明 | 证据 | 实测 |
| --- | --- | --- | --- |
| 5 | `git clean -fd` / `-fdx` 被拒（2.4.5 CHANGELOG 的表格行；GPT/Gemini 的 P1） | `lib/guard.js:327-343`、`:1286-1301`（规则）；`lib/index.js:107-129`（预过滤**无 `git`**）；`test/kind-matrix.test.mjs:33-92`（代表集**无 git clean**） | `classifyCommand` → `deny/delete`；**hook（pwsh / bash / cmd / terminal_send）→ PASS，宿主照跑**。`git clean -n`、`git reset --hard`、`git checkout -- f` 两路都 `allow` |
| 6 | `sed -i 's/a/b/g' f` 被拒（Gemini 热点 1 的"高摩擦"；README:77 的承诺） | `lib/rewrite-guard.js:468-474`、`:756-777`、`:731-737`；`lib/index.js:107-129` | **两个方向都错**：`classifyCommand` → `deny/in-place-rewrite`，但 hook → **PASS**（`sed|truncate|dd|tee|cp|mv` 全无预过滤信号）。同一行的 `Get-Content a.md \| Tee-Object a.md` 被拒，`cat a.md \| tee a.md` 放行 |
| 7 | 反引号可绕过删除动词：`R\`emove-I\`tem`（Gemini 词法盲区，实际范围更大） | `lib/guard.js:1080`（`parseDeleteStatement`）、`:1139`、`:1156`（token 原样比对） | `R\`emove-I\`tem`、`Remove-I\`tem`、`R\`emove-Item` → `allow`；同一缺口覆盖四类规则：`s\`delete -p 3 …`、`sh\`red -u …`、`Format-V\`olume -DriveLetter D`、`Clear-Recy\`cleBin -Force` 全部 `allow` |
| 8 | 带 glob 的删除被改道到不展开 glob 的 `file_trash`（GROK 5） | `lib/guard.js:1724`（只认 3 个裸串）、`:437`（`-Recurse` 必须在 `*` 左侧）；`lib/index.js:625-631`（`stat`） | `Remove-Item C:\tmp\*.log` → `rewrite ["C:\tmp\*.log"]`；`file_trash(["C:\tmp\*.log"])` → `no such file or directory`。`-Recurse` 写在 glob 之后同样改道 |
| 9 | `diskpart clean`（GPT 三.2） | `lib/guard.js:92-107`、`:157-167`（无 diskpart）；全库 0 命中 | `diskpart clean`、`clean all`、`/s script.txt` → `allow`（classify 与 hook） |
| 10 | `.py` 脚本写入按 shell 动词表判（GROK 4） | `lib/guard.js:582-584`（扩展名表）、`:590`（动词表） | `.py` + `del d['a']` → `deny/script`；`.py` + `os.remove` / `shutil.rmtree` → `allow`；`.js` + `fs.rmSync` → `allow`（`\brm\b` 在 `rmSync` 里无词边界）；`.js`/`.ts` + `fs.rm(` → `deny` |

### 2.3 三份 review 都没提到的偏松面（本轮实测新发现）

| # | 问题 | 证据 | 实测 |
| --- | --- | --- | --- |
| 11 | 三条豁免按**整条命令**求值：备份、有界替换、两侧编码都不绑定目标文件，所以任何一处"看起来安全"的写法可以洗白另一处整档重写 | `lib/rewrite-guard.js:636-677`（`hasCopyStepFor` 的 `samePath` 只用 `lit:` key 构造匹配器）、`:908-909`、`:731-737` | `Copy-Item b.md b.md.bak` 之后改写 `a.md` → `allow`；写 `$env:TEMP\x.tmp` 也 `allow`；`a.md` 的一次 `-replace` + 两侧编码把 `b.md` 的 `$b.ToUpper()` 整档重写洗成 `allow` |
| 12 | 编码豁免只查 token 是否存在，不比较值 | 同上 `:731-737` | 读 `-Encoding utf8` + 写 `-Encoding ascii` → `allow`；实测 ascii 写把 7 个中文字符全变成 `?` |
| 13 | `collectLiterals` 取**最后一次**赋值当唯一字面量 | `lib/rewrite-guard.js:341-383` | `$f='C:\t\a.md'; Get-Content $f; $f='C:\t\b.md'; Set-Content $f 'x'` → `deny`（读 a 被当成读 b），命令里根本没有读改写 |
| 14 | cmd 风格开关被当成删除操作数，改道指令必然失败 | `lib/guard.js:1080`（只跳过 `-`/`--`）、`lib/index.js:419-455` | `del /s /q C:\tmp\*.log` → `rewrite ["/s","/q","C:\tmp\*.log"]`；交给 `file_trash` → `refusing to recycle a drive root: "S:\"` |
| 15 | `\\?\UNC\host\share` 越过共享根检查，进入 staging 的"整份共享拷贝 → 回收副本 → `rm -rf` 原件" | `lib/staging.js:192` 依赖 `isShareRoot`（`:81-84`），前缀使段数变 4 | `validateTrashTarget` → `ok:true`；`stageForRecycle` 越过共享根拒绝，进入 `walkTree`。共享可达时序列就是永久清空整份共享，而桥接的 UNC 拒绝根本不会执行 |
| 16 | 桥接无条件剥 `\\?\`，`\\?\Volume{GUID}\…` 被重解释为相对 cwd 的路径 | `scripts/recycle-bin.ps1:110-117` | `\\?\Volume{b9e9178a-…}\x` → `F:\<插件目录>\Volume{b9e9178a-…}\x` → `0x7B`。cwd 下恰好有同名目录时会回收另一个文件 |
| 17 | `trash_status` 吞掉桥接的 `error`，查询失败报成"空回收站" | `scripts/recycle-bin.ps1:425-432`、`lib/recycle.js:165-173`、`lib/index.js:725-726` | `recycleBinUsage('Q:')` → `{items:0,bytes:0}`（桥接回复里带 `error`，被丢弃）——正是"用它确认是否进了回收站"最不能出错的地方 |
| 18 | 配置耦合：`blockTruncatingWrites:false` 连 `git clean` 一起关；`blockDestructiveCommands:false` 让整个 listener 消失，连改写检查一起没有 | `lib/index.js:316-333,367,375`；`lib/guard.js:1288,1595` | `Config` 无 `blockInPlaceRewrite` / `blockUncheckedSliceWrite` / `blockEmptyWrites`；实测两种关法都如上 |

### 2.4 2.4.5 已经修掉的（三份 review 里已不成立的部分）

| 声明 | 现状 | 证据 |
| --- | --- | --- |
| GROK 2（b）：pwsh 反引号被当命令替换、测试锁死该语义 | 已改：`OPAQUE_CONSTRUCTS` 的反引号项限 `dialects:['bash']`，pwsh 侧改由操作数级拒绝且理由写"escape character" | `lib/guard.js:423-437`、`:1694-1704`；`test/guard.test.mjs:219-235` |
| GROK 2（c）：`bash -c "echo Remove-Item x"` / `pwsh -c "Write-Output 'Remove-Item x'"` 被拒 | 已改：按语句拆开判 | CHANGELOG 2.4.5 表格行；`test/escapes.test.mjs` 新增用例 |
| GPT 三.1 的 `git clean`（分类器层） | 已加规则，但钩子层无效 | 见 §2.2 #5 |
| GPT 二.1 的"重构没有通过形状" | **不成立**：任何读改写前面加一条 `Copy-Item $f "$f.bak"` 就放行（正是拒绝文案第 1 步） | `lib/rewrite-guard.js:636-677`；实测 `S1`=allow |
| Gemini 词法盲区（ii）：`-WhatIf` 纯形态被 allow、混合形态被拒 | **不成立**：没有 allow 分支；纯 `-WhatIf` 也是 `rewrite/delete`，再由 hook 翻成 `DELETE_GUARD_DRY_RUN` | `lib/guard.js` 全文无 `-WhatIf → allow`；`lib/index.js:278-286,433-443` |
| Gemini 热点 2 的词表（`fs.rmSync`/`shutil.rmtree` 被拦） | **不成立**：拦截词只有 shell 动词表，`fs.rmSync`/`shutil.rmtree` 不匹配 | `lib/guard.js:582-590` |

### 2.5 成立但属于"效率/误伤"（每一轮都能通过，不进 2.4.5 的 P0）

| 声明 | 实测 | 出口（拒绝文案里已有或应补） |
| --- | --- | --- |
| GROK 1：同命令内绑成字面量的变量仍整段拒 | `$p = 'C:\tmp\a.txt'; Remove-Item $p` → `deny/opaque`；2.4.4 那 78 条 opaque 里复算到 **28 条**属此形态（GROK 说 31，`fp:opaque` 桶在仓内数据里不存在，无法复核"70 条"） | 同命令内 `$x = '<字面量>'` 且无二次赋值时，代入后继续走 provider/根路径检查 |
| GROK 2（a）：`$()` 按整段命令判 | `Write-Output "done $(Get-Date)"; Remove-Item a.txt` → `deny/opaque` | 作用域收窄到"含删除动词的语句 + 删除操作数" |
| GROK 2（终端互染）：pwsh 的 `\`n\`n` 转义对 + 删除 → 终端工具判 deny | `terminal_send` → `DELETE_GUARD_OPAQUE` | 合并规则：pwsh 已判 rewrite、bash 仅因成对反引号判 opaque 时取 rewrite |
| GROK 3：豁免要求两侧 `-Encoding` | 属实（只写一侧也拒） | **不放宽**：见 §3 的反例 |
| GROK 3b / slice 文案 | 文案末句已有备份条件，但没点明"只补断言仍会被拒" | 补一句因果 |
| Gemini 热点 3：slice-risk 对全新输出文件也开火 | 属实：写全新 `out.md` 也 `deny/slice-risk` | 需先确认事故形态再收窄（见 §4） |
| Gemini 热点 4：`for/foreach` 让写后读豁免失效 | 属实，但 `$_`/`$_.FullName` 类目标不触发（`exprKeys` 对含 `$` 的非裸变量返回空），批量生成再回读的常见写法是 allow | 作用域收窄到"同一 key 的两条语句被循环包住" |
| Gemini 5 前半：`/tmp` 一律拒 | 属实（理由已给 `cygpath -w`，2.4.5 修的） | 保留拒绝 |

---

## 3. 与原始意图的对照

意图里三件事，对应现状：

| 意图场景 | 现在的状态 |
| --- | --- |
| 工作区被清空 | `Remove-Item -Recurse` 被改道；但 `\\?\` 前缀可让 `file_trash` 直接回收工作区根（§2.1 #1），`git clean -fdx` 在真实钩子上放行（§2.2 #5），`git reset --hard` 未覆盖 |
| 整个盘被清空 | 盘根检查存在且 `\\?\C:\` 恰好被拒（但走的是"网络共享根"规则，不是盘根规则）；Windows / Program Files / 回收站库 / 工作区根可被 `\\?\` 绕过（§2.1 #1）；`diskpart clean` 未覆盖（§2.2 #9）；映射盘 `S:` 上"回收"实为永久擦除（§2.1 #3） |
| 文档编辑时意外清空 | 读改写与切片被拒（这是插件的核心价值），但：空内容覆盖放行（§2.1 #4）、`sed -i` 在真实钩子上放行（§2.2 #6）、编码值不比较（§2.3 #12）、备份/有界替换豁免可被无关文本满足（§2.3 #11） |

**意图之外、当前摩擦主源**：`blockScriptDeletes` 拒绝"把含删除动词的文本写进脚本文件"（写不等于执行，
且该规则用 shell 动词表扫 `.py`，把 `del d['a']` 判成删除、把 `os.remove` 漏掉）；`sed -i` 的"两侧编码"
要求对一个不做转码的工具没有意义。这两条与"防不可逆损失"无关，可以按意图裁掉或改写判据。

**但放宽的前置条件是先修 §2.3 #11/#12**：现在三条豁免本来就是整条命令文本的存在性检查；在这个基础上
再放宽，等于把编码检查与目标绑定一起去掉。GROK 3 的"同族 cmdlet 往返安全"实测不成立——
pwsh 7.7.0 + GBK 文档，`Get-Content -Raw` → `.Replace` → `Set-Content` 无编码：24 B 变 58 B、
16 个 U+FFFD、替换的 needle 一个都没命中。安全的条件不是"同族"，是"文件本来就是 UTF-8"，
而事故文件正是中文 GBK 台账。**该建议否决。**

---

## 4. 对三份 review 建议的处置

| 建议 | 处置 | 理由 |
| --- | --- | --- |
| 统一 `\\?\` 规范化后再检查（GPT P0#1） | **采纳，P0** | 已端到端复现；同时修 `\\?\UNC\` 的共享根与 `\\?\Volume{GUID}` 的重解释 |
| 证明真的进了回收站，否则保留原件（GPT P0#2） | **采纳，P0** | 用 `SHQueryRecycleBinW` 前后差值 + `$I` 记录匹配；失败即保留原件并报失败。这是"可恢复"承诺的唯一证据 |
| `uncRecoverableMove` 默认改 false（GPT） | **否决** | 会让共享删除变成纯拒绝，模型转而用别的路（`Move-Item` / `robocopy /MOV` 已是文档承认的洞）。要修的是映射盘识别与回收证明，不是关掉 staging |
| 拆 `blockTruncatingWrites` 为三个键（GPT 二.3） | **采纳，P1（配置面变化）** | 同时把 `git clean` 从该键挪到删除保护下（§2.3 #18 是错误耦合） |
| 增加空内容覆盖检测（GPT 二.2） | **采纳，P1** | 正中意图；`Clear-Content` / `Set-Content ''` / `truncate -s 0` / 空重定向，默认开。同步改 `README.md:155` 的口径（不覆盖"有内容的新写"，覆盖"空写"） |
| 用 PowerShell AST 替代文本解析（GPT 二.6） | **推迟** | 每条命令 spawn 一次 pwsh 的代价与 `pre-execute` 的成本预算冲突；cmd/bash 各有语义。先补 §2.2 的可判形态 |
| 同族 cmdlet 往返放行（GROK 3） | **否决** | GBK 文档实测出 16 个 U+FFFD（§3） |
| 同命令字面量绑定代入（GROK 1） | **采纳，P2** | 只在"单次赋值 + 无二次绑定"时代入，代入结果继续走根路径/provider 检查 |
| `$()` 只判删除操作数（GROK 2a） | **采纳，P2** | 作用域含"管道喂给删除的语句" |
| glob 改 deny 而非改道（GROK 5） | **采纳，P1** | 改道到不展开 glob 的工具保证一次失败；deny 的文案给"先列举再给显式路径" |
| 脚本写入按扩展名分表（GROK 4） | **采纳，P2** | `.py` 用 `os.remove`/`shutil.rmtree`/`Path.unlink`；`.js/.mjs/.ts` 用 `fs.rm|rmSync|unlink|rmdir`；`del d['a']` 不再算 |
| 脚本写入改判"写了又执行"（Gemini P0#3 的合理内核） | **采纳，P2** | 写不是执行；同一命令里写了又跑才拒。`SECURITY.md` 已承认"脚本文件里已有的删除"是洞，拒绝写入买不到额外安全 |
| `sed -i` 无编码即放行（Gemini P0#1） | **部分采纳，但要换判据** | sed 不做转码，"两侧编码"对它无意义；真正的风险是脚本里的 `d`/`c`/`i`/`a` 与能匹配整行的 `s`。按 sed 脚本形状判，并按 §2.2 #6 补预过滤 |
| slice-risk 只对"目标也被读/已存在"开火（Gemini P0#3） | **暂缓** | 事故是 `$lines[0..($idx-1)]` 把 605 行写成 24 行，收窄前必须先确认那一形态的目标是否在命令内被读；否则是把事故形态放回去 |
| `-WhatIf` 不一致（Gemini） | **不改判据** | 实测声明有误（§2.4）；只把混合语句的 DRY_RUN 文案按语句区分 |
| 反引号命令词规范化（Gemini 词法盲区） | **采纳，P1** | 缺口不限于删除动词（§2.2 #7），四类高危规则共用；pwsh 方言内先剥反引号再比对 |

---

## 5. 2.4.5 的处置顺序

**P0（本轮必须做，否则 2.4.5 不能算完成）**

1. `\\?\` 入口规范化 + `\\?\UNC\` 共享根 + `\\?\Volume{GUID}` / `\\?\GLOBALROOT` 明确拒绝；
   测试 7 个形态与不带前缀的判定逐条相等。
2. 回收记录证明（`SHQueryRecycleBinW` 前后差值 + `$I` 匹配），失败保留原件；
   `recycle.js` 不再吞 `error`（连带修 `trash_status`）。
3. 映射盘：桥接加 `DriveType -eq Network` 拒绝；`staging` 覆盖不到映射盘这点写进 README。
4. `git clean` 进预过滤，并把 2.4.5 新增的每条规则补进 `test/kind-matrix.test.mjs` 的代表集
   （`git clean`、`node/python` 读改写、`tr` 自毁、`execSync`、`iex` 管道、`.tmp` 副本）。
   该层现在按 **kind** 断言覆盖（`test/kind-matrix.test.mjs:153-162`），`git clean` 的 kind 是 `delete`，
   于是它搭着 `Remove-Item` 的代表通过了断言——测试结构要改成"每条规则都有代表"，
   否则下一条同 kind 的新规则会以同样方式漏掉。

**P1（同一版本，成本低、都落在承诺或意图上）**

5. 空内容覆盖（第三类规则，默认开）+ `README:155` 口径同步。
6. 三条豁免绑定目标：备份必须命中该目标的 key、有界替换/编码按目标求值、编码值必须相等；
   `collectLiterals` 不再取最后一次赋值。
7. `diskpart` 进 wipe；反引号命令词规范化；glob 删除改 deny；cmd 开关不进操作数。
8. `sed/truncate/dd/tee/cp/mv` 预过滤（补漏）；`sed` 按脚本形状判。
9. `docs/incidents/` 移到 `docs/archive/incidents/` 后，README×3、SECURITY、CHANGELOG 共 9 处引用
   全部指空，需同步（否则"链接能打开"这一条不成立）。

**P2（推到 2.5.0，且必须排在 §2.3 #11/#12 之后）**

10. 字面量代入、`$()` 作用域、脚本扩展名分表、写-执行边界、slice/循环作用域、配置拆键、
    终端合并规则、`-WhatIf` 文案。

**发布门禁**：`npm publish` / GitHub Release 仍须拿到针对 2.4.5 的明确指示（AGENTS §6.7）。
本轮所有改动都留在本地；README:44 已经写了从 `#v2.4.5` 安装，在发布前这个 tag 不存在。

---

## 6. 边界

- 未在真实 DSH 会话里跑"拒绝后模型怎么反应"，所以本文只报"判定是什么"，不报"多花了多少轮"。
  `SECURITY.md` 的 126 次拒绝（58 会话）仍是唯一的行为侧数据。
- 容量分支（§2.1 #2 的 C: 25 GiB 上限）没有实测：让一个超限项进回收站可能触发 bin 淘汰，
  清掉用户已有的可恢复条目。结论止于"按 API 语义与桥接判据可以发生"。
- 映射盘 `S:` 只验到"volume 检查通过、会被当成本地盘直送桥接"，没有在共享上真删文件。
- 6,000 条样本偏重本插件自身维护（大量 README 改写），绝对比例不能外推；形态排序比数字可靠。
- 三份 review 的 156/241、31/78、70/78 三个计数在仓内数据里复现不出同口径（见 §2.5、§2.2），
  本文只采用能复现的 28/78。

## 附：复现

```shell
# 判定与钩子（只读）
node temp/probe-main.mjs        # 分类器逐条 verdict
node temp/probe-hook.mjs        # 同一批命令走真实 pre-execute 钩子
node temp/probe-prefilter.mjs   # 分类器拒绝但预过滤不匹配的形态
node temp/probe-hook2.mjs       # sed / truncate / git clean 在钩子上
node temp/probe-extended-path.mjs  # \\?\ 系列在 validateTrashTarget 上的判定
node temp/review-final-measure.mjs # 6,000 条样本的 deny 率
node test/run-all.mjs           # 233 项，全绿（本文 §1–§6 写作时的基线是 222 项）
```

---

## 7. 实施结果（2026-11-26，工作树 = 2.4.5）

§5 的 P0 与 P1 全部落地；P2 未动。验证：`node test/run-all.mjs` **233 项全绿**；
`node scripts/verify-readme-structure.mjs` 三份 README 结构一致；6,000 条真实命令样本
deny 56 → 70（pwsh，0.93% → 1.17%），其中新增 `empty-write` 3、`git-discard` 2、
`in-place-rewrite` 41 → 51（多出的拒绝都是同一文件确实被读写）；预过滤多放行进分类器的命令 8 条（+0.13%）。

| 项 | 落地方式 | 验证 |
| --- | --- | --- |
| `\\?\` 规范化 | `lib/move-guard.js` 的 `normalizeDevicePath`：`\\?\C:` → `C:`、`\\?\UNC\` → `\\`、`\\?\D:` → `D:\`；`\\?\Volume{…}`、`\\?\GLOBALROOT`、`\\.\` 明确拒绝。桥接侧同样拒绝（不再靠剥前缀兜底） | `test/move-guard.test.mjs` 七形态与不带前缀判定逐条相等；`\\?\` 前缀文件曾被真实回收进 F: 回收站，现在被规范化后按普通路径判定 |
| 回收记录证明 | 桥接在调用前后用 `$I` 记录校验：只认本次调用之后写入、且原路径匹配的记录；`missing` 与 `unreadable` 分开报 | 真回收（文件、目录、CJK 名）全部 `found`；记录不可读时不再谎报"已抹除" |
| 映射盘 | `Test-RecyclableVolume` 增加 `DriveType Network` 拒绝 | 本机 `S:`（Network + NTFS）从"静默永久擦除"变成显式拒绝 |
| `git` | `gitDestroysWorktree` 覆盖 clean/rm/reset --hard/checkout --/restore，并从 `blockTruncatingWrites` 下移出 | 预过滤同步，钩子层实测拒绝；`git clean -n`、`git rm --cached`、`git restore --staged`、`git checkout <branch>` 仍放行 |
| 空内容覆盖 | `rewrite-guard.js` 第三类规则 `empty-write`（`Clear-Content`、空值/`$null` 的 `Set-Content`/`Out-File`、`truncate -s 0`、裸 `>`、`cp /dev/null`），独立配置键 `blockEmptyWrites` | 10 个形态在分类器与钩子上都拒；带内容的写不受影响 |
| 豁免绑定目标 | 备份必须提及目标文件；有界替换+编码只在"单一读写目标"时生效；编码值必须相等；`collectLiterals` 按语句解析，不再取最后一次赋值 | X1/X2/X3（无关备份）、T2（跨文件洗白）、U1（utf8→ascii）全部转拒；S1（先备份）与 U2（同编码）仍放行 |
| `diskpart` / 反引号 / glob / cmd 开关 | `diskpart clean|/s` 进 wipe；`programName` 剥反引号（含 `s`delete`、`Clear-Recy`cleBin`）；任何 `*`/`?` 操作数改 deny；`del /s /q` 的开关不再当操作数 | `test/guard.test.mjs`、`test/kind-matrix.test.mjs` |
| `sed` 一族 | 预过滤新增 `sed|truncate|dd|tee|cp|mv`；`sed -i` 按脚本形状判：有界 `s///` 放行，`d`/整行模式/锚定空核拒绝 | `test/rewrite.test.mjs` 五例 |
| 文档 | 三份 README 同步（通配符、git、空写、映射盘、`sed`、配置键、测试数）；CHANGELOG 2.4.5 重写为按影响分组；SECURITY 补空写、回收证明、映射盘与 git；`docs/incidents/` → `docs/archive/incidents/` 的 9 处引用全部同步 | `verify-readme-structure.mjs` 通过 |

**装配**：`pnpm pack --pack-destination F:\Workspace\projects\dsh-plugin-dev\temp\pack` →
`dsh plugin --profile web remove dsh-delete-guard` → `add file:…\dsh-delete-guard-2.4.5.tgz`。
profile 副本与工作树 `lib/`、`scripts/` 逐字节一致（SHA256 前 16 位相同）；
另起 `dsh --profile web --port 3099 --no-open` 验证能加载、无 plugin tree 报错，随后关闭该实例。
**3080 上正在跑的进程仍是旧代码**，重启 dsh web 后才生效。

**仍未做（P2 与新发现）**：

- 同命令字面量代入、`$()` / 终端合并的作用域收窄、脚本写入按扩展名分表与"写-执行"边界、
  slice/循环作用域、配置拆键 —— §5 的 P2 清单，未动。
- `sed -i` 的锚定模式（`s/^/> /`、`s/x$/y/`）仍按"可能整行"拒绝：只放行核内还有字面文本的模式。
- 映射盘不做暂存（只拒绝）：要恢复内容需先复制到本地 NTFS 卷，README 已写明。
- `\\?\` 之外，`\\.\` 设备路径已拒绝；`\\?\GLOBALROOT` 同理。
- §2.3 #11 的豁免作用域现在是"单目标"；多目标命令里每条都要各自的备份，属有意从严。

