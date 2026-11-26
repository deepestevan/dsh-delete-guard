# review2：当前版本是否因过严而拖慢 agent

> 审查对象：`dsh-delete-guard` 2.4.5（工作目录 `F:\Workspace\projects\dsh-plugin-dev\dsh-recycle-bin-guard`）。
> 方法：通读 `lib/` 七个模块、`package.json`、`README.md`、`SECURITY.md`、`CHANGELOG.md` 与事故记录；
> 用仓库自带的 6,000 条真实命令样本重新测量当前分类器；另写只读探针逐条取 verdict。
> 本文件不执行任何被测命令，也不改动源码。证据链只来自上述源码、样本和本轮探针。
> `docs/` 不在 `package.json` 的 `files` 白名单里，本文件是维护者侧记录，不随包发布。

## 1. 意图与工具

插件把「删除」定义为任何会让文件内容不可恢复地消失的动作，并在 `tools/pre-execute`
接缝上把模型发出的命令拦下来。宿主契约不允许改写已冻结并落日志的参数，所以拦截的
唯一合法形状是 `deny` + 在理由里给出可照做的替代路径。它注册两个工具：

| 工具 | 作用 |
| --- | --- |
| `file_trash { paths, reason? }` | 唯一允许的删除方式。本地条目走 `SHFileOperationW(FOF_ALLOWUNDO)`；UNC 条目先复制到本地 NTFS 卷、校验、回收副本，最后才删原件 |
| `trash_status { drive? }` | 报告某盘回收站的项目数与占用 |

覆盖的拦截面分四组：shell 删除动词（改写为 `file_trash` 指令）、永久擦除与清空回收站、
内联脚本/子进程里的删除、以及「没有删除动词的毁灭」——读改写同一唯一副本和未断言的
切片端点 + 写文件（源于 2026-11-14 的 605→24 行事故）。

用户给出的意图边界很关键：**要防的是幻觉/TYPO 造成的不可逆删除或清空，不是把所有
写操作都变成需要用户确认的敏感操作。** 这条边界决定了下面什么叫「过严」：一条规则
如果让模型多花一轮去满足一个文本层面的条件，而该条件既不对应真实的内容损失风险、
也没有在拒绝理由里说清，那就是效率损失；如果它对应真实风险且给出了最短放行路径，
那是必要的成本。

## 2. 总体判断

**当前版本总体没有过严。** 6,000 条真实命令样本上，当前分类器的判定是：

| dialect | allow | rewrite | deny |
| --- | --- | --- | --- |
| pwsh | 5,943（99.05%） | 1 | 56（0.93%） |
| bash | 5,945（99.08%） | 1 | 54（0.90%） |

deny 的构成（pwsh）：`in-place-rewrite` 41、`opaque` 8、`slice-risk` 3、`erase-api` 2、
`wipe` 1、`script` 1。也就是说，九成以上的摩擦集中在一类规则上，而该类里多数命令
确实是「读回文件唯一副本再写回」的形态。

以下几类实测全部放行，说明通用工作没有被误伤：

- `npm run build`、`node --test test/*.test.mjs`、`git status`
- `Get-Content shred.exe`、`Select-String -Pattern "Remove-Item" *.md`、`powershell -Command "Get-Command shred"`
- `bash -c "echo Remove-Item x"`、`node -e "console.log('docs mention shred as a tool name')"`
- 只列举回收站条目、只列出动词、`InvokeVerb('Restore')`
- 写日志后回读核对：`python x.py 2>&1 | Out-File out.txt; (Get-Content out.txt).Count`
- `Add-Content`、`>>`、`Copy-Item a.md b.md`、`sed -i.bak`

代价也在可接受范围：真实 `file_trash` 调用要 spawn PowerShell（~70 ms），分类器在长命令上
约 192 µs（2.4.2 的对比测量），前置快筛把大部分命令挡在分类器之外。

**但存在 4 处具体的过严实现**，它们不是「安全取向太保守」，而是判据与自己的意图/文档
不一致，会产生本可避免的重试。以下按修复收益排序。

## 3. 发现

### F1（中）擦除标志用全文正则，读文档里出现它就被拒

**位置**：[lib/guard.js:149-153](<lib/guard.js#L149-L153>) 定义
`WIPE_FLAG_SHAPES = [/\bcipher\s+\/w\b/i, /\bcipher\s+\/w:\S+/i, /\bformat\s+[a-z]:/i]`；
[lib/guard.js:1329-1333](<lib/guard.js#L1329-L1333>) 对**整条命令**逐条 `rule.test(command)`。

**机制**：同一文件里的 `WIPE_PROGRAMS` 特意按程序位判定（`wipeProgramIn`，
[lib/guard.js:658-754](<lib/guard.js#L658-L754>)），所以 `Get-Content shred.exe` 能放行；
但标志形状绕过了这层，任何位置的字面串都算「要擦除」。代码注释给出的理由是
「no read-only command is spelled `cipher /w` or `format D:`」——搜索模式恰好就是反例。

**实测**：

| 命令 | verdict |
| --- | --- |
| `Select-String -Pattern "format D:" notes.md` | `deny/wipe` |
| `Get-Content notes.md \| Select-String "cipher /w"` | `deny/wipe` |
| `echo "format D: is a wipe flag"` | `deny/wipe` |
| `Select-String -Pattern 'cipher /w' README.md` | `deny/wipe` |
| `Get-Content format-D-log.txt` | `allow`（对照：缺空格，不匹配） |

**影响**：维护这份插件自己的文档（README 里写了 `cipher /w`、`format X:`）就会被拒绝，
理由是「永久擦除工具已禁用」。不丢数据，但模型按错误理由改命令，白费一轮。

**建议**：把 `WIPE_FLAG_SHAPES` 改成按语句、在命令位判定：`cipher`/`format` 必须是语句的
命令词或启动器载荷，且标志不在引号字符串内。补成对用例：`cipher /w E:` 仍拒，
`Select-String -Pattern 'cipher /w' README.md` 必须放行。

### F2（中）`.tmp` 副本不被认可；注释与 README 说的放行路径和实现不一致

**位置**：

- [lib/rewrite-guard.js:557](<lib/rewrite-guard.js#L557>) 的注释说副本可以是
  `<target>.bak*` / `<target>.tmp*` / `.new` / `.orig`；
- [lib/rewrite-guard.js:209-210](<lib/rewrite-guard.js#L209-L210>) 的 `BACKUP_MARKER` 只含
  `bak|backup|orig|old`，`TEMP_MARKER` 只含 `$env:TEMP|%TEMP%|/tmp/|\Temp\`，都没有 `.tmp`/`.new` 后缀；
- [lib/rewrite-guard.js:605](<lib/rewrite-guard.js#L605>) 的放行判断只用这两个 marker；
- [lib/rewrite-guard.js:742-746](<lib/rewrite-guard.js#L742-L746>) 的 `writesTempOrBackup`
  认识 `.tmp`，但全仓库只有定义、没有调用点；
- [README.md:77](<README.md#L77>) 写「先备份到 `.bak`，或写临时文件校验后再换上去的写法放行」。

**实测**：

| 命令 | verdict |
| --- | --- |
| `Copy-Item $f "$f.bak"; $t=Get-Content $f -Raw; Set-Content $f $t` | `allow` |
| `Copy-Item $f "$f.tmp"; $t=Get-Content $f -Raw; Set-Content $f $t` | `deny/in-place-rewrite` |
| `$o="$env:TEMP\x.tmp"; $t=Get-Content $f -Raw; Set-Content $o $t; Copy-Item $o $f -Force` | `deny/in-place-rewrite` |

样本里还有真实命令用 `$bak="$p.bak-<时间戳>"; Copy-Item $p $bak; …` 先备份再覆盖，
同样被拒——`collectLiterals`（[lib/rewrite-guard.js:311-323](<lib/rewrite-guard.js#L311-L323>)）
丢掉含 `$` 的右值，副本路径解析不到目标上。

**影响**：模型照文档写「复制一份到临时文件再改」会得到拒绝，而同形的 `.bak` 版本放行。
更微妙的是文档的第二半句：把**新内容**写进临时文件、校验、再覆盖，按设计是不放行的
（校验输出不等于原件可恢复），README 却说放行——两处都要改，否则模型会反复踩。

**建议**：在 `hasCopyStepFor` 的 marker 里补 `.tmp`/`.new` 后缀并启用 `writesTempOrBackup`；
让 `collectLiterals` 传播含变量引用的备份路径；README 改为「先把**原件**复制到
`<name>.bak`/`.tmp`，再写回」，明确临时文件里必须是旧内容。

### F3（中低）`in-place-rewrite` 的拒绝理由没写最省事的放行条件

**位置**：拒绝文案 [lib/rewrite-guard.js:840-852](<lib/rewrite-guard.js#L840-L852>)；
放行条件 `hasBoundedSubstitution(command) && hasPinnedEncoding(command)`
在 [lib/rewrite-guard.js:834](<lib/rewrite-guard.js#L834>)，两个谓词分别在
[658-669](<lib/rewrite-guard.js#L658-L669>) 和 [685-726](<lib/rewrite-guard.js#L685-L726>)。

**实测**：

| 命令 | verdict |
| --- | --- |
| `$t=Get-Content a.md -Raw; $t=$t.Replace('a','b'); Set-Content a.md $t` | `deny/in-place-rewrite` |
| `$t=Get-Content a.md -Raw -Encoding utf8; $t=$t.Replace('a','b'); Set-Content a.md $t -Encoding utf8` | `allow` |

拒绝文案只给「先 `.bak`、写临时文件、校验、覆盖」和「用 `edit` 工具」，没提「两侧显式
`-Encoding`」。而 6,000 条样本里的 41 条 `in-place-rewrite` 拒绝中，有相当一部分是
定点替换缺编码；2.4.2 的实测也记录剩余误伤主体是读侧未显式编码。也就是说，最常见
的那一类拒绝，最短放行路径没有告诉模型。

**建议**：`hasBoundedSubstitution` 为真而 `hasPinnedEncoding` 为假时，在理由首行加一句
「读写两侧都写 `-Encoding utf8` 即可放行（等价于 `edit`）」。不改判据，零安全风险。

### F4（低）bash 下 `/tmp/...` 一律拒，理由没给可用替代

**位置**：[lib/guard.js:967-995](<lib/guard.js#L967-L995>)，未映射的 MSYS 挂载点在
[986-991](<lib/guard.js#L986-L991>) 直接 `refuse`。

**实测**：`rm -rf /tmp/build`（bash）→ `deny/opaque`；`rm -rf /c/tmp/build` → `rewrite/delete`。
持久终端是 ambiguous 工具，两种方言合并后 `rm /tmp/x` 也是 deny。

**判断**：拒绝本身站得住——`/tmp`/`/usr` 的真实落点随安装而变，不能猜。但拒绝理由只说
「先解析、再传 Windows 路径」，模型无从知道本机 `/tmp` 对应哪里，容易反复尝试。

**建议**：保留拒绝，理由里给出本机可执行的解析命令（`cygpath -w /tmp`）或已知映射，
让替代路径一次到位。

## 4. 审查中确认没有过严的部分

为了避免只报问题，以下都实际跑过并放行：

- 删除动词和非文件位同名：`Get-Content shred.exe`、`Select-String -Pattern "Remove-Item"`、
  `powershell -Command "Get-Command shred"`。
- 只提删除词不执行：`bash -c "echo Remove-Item x"`、`node -e "console.log('docs mention shred...')"`。
- 回收站只读与还原：列举 `Namespace(10).Items()`、枚举 `Verbs()`、`InvokeVerb('Restore')`。
- 常规工程命令：`npm run build`、`node --test`、`git status`、`Copy-Item a.md b.md`、`Add-Content`。
- 写日志后回读核对（顺序判定生效）：`python x.py | Out-File out.txt; (Get-Content out.txt).Count`。
- `sed -i.bak` 这种编辑器自带副本的写法。
- 真正需要拦的形态仍被拦：`Remove-Item -Recurse -Force`、`Get-ChildItem | Remove-Item`、
  `Clear-RecycleBin -Force`、未断言切片端点 + 写文件、`Remove-Item $var`（变量目标）。

## 5. 边界与本次未做的事

- 样本是本机的 6,000 条命令，且偏向本插件自身的维护（大量 README 改写），绝对比例换机器会变；
  形态排序比数字更可靠。
- 只走 `classifyCommand` 和已有测试覆盖的 hook 接线；没有在真实 DSH 会话里发工具调用，
  也没有执行任何被测命令。因此这里报的是「会被拒绝」而不是「用户实际多花了多少轮」。
- 严格度并不均匀：`git clean -fd`、`npm run clean`、Python `open(p,'w')` 的读改写实测都是
  `allow`。这说明成本花在了文本可判的窄形态上，而不是统一的安全升级。若目标是防幻觉导致的
  不可逆损失，补这些缺口比继续收紧已校准的规则更值得，但那是另一个议题，不在本次过严审查的结论里。

## 6. 复现方法

在仓库根目录执行（只读，不执行被测命令）：

```js
// review2-repro.mjs
import { classifyCommand } from './lib/guard.js';
const opts = { dialect: 'pwsh', forbidEmptyRecycleBin: true, forbidWipe: true,
               blockScriptDeletes: true, blockTruncatingWrites: true };
const cases = [
  'Select-String -Pattern "format D:" notes.md',                 // F1: deny/wipe
  'Copy-Item $f "$f.tmp"; $t=Get-Content $f -Raw; Set-Content $f $t', // F2: deny
  "$t=Get-Content a.md -Raw; $t=$t.Replace('a','b'); Set-Content a.md $t", // F3: deny
];
for (const c of cases) {
  const v = classifyCommand(c, opts);
  console.log(v.action + (v.kind ? '/' + v.kind : ''), '|', c);
}
```

6,000 条样本的 deny 率：把 `temp/cmd-sample.json` 逐条喂给 `classifyCommand`，
按 `action` 和 `kind` 计数即可；本文件的表格是这么得到的。`node test/run-all.mjs` 当前全绿。
