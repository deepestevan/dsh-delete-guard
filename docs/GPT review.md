总体结论
不是简单的“收得太紧”，而是保护范围有些错位。

常规删除命令拦截并转交 file_trash 的设计是合理的，现有实现也已经经过多轮真实命令回放和修正。真正影响 Agent 正常工作的，主要是额外加入的原地改写保护：它对一部分正常的读改写操作过于保守。

但源码审查还发现了两个比误拦截更严重的问题：
1. 扩展路径 \\?\ 的规范化发生在安全检查之后，可能绕过工作区根目录和系统目录保护。
2. 回收站桥接程序把“源路径消失”当作“已进入回收站”的证据，但 Windows API 并不保证每次都能回收。
因此，我不建议直接放宽核心删除拦截。应当先修复这两个安全问题，再把删除保护、内容覆盖保护和间接命令保护分开配置。

本次审查以仓库 main 分支的 2.4.4 版本为基线，重点检查了 index.js、guard.js、rewrite-guard.js、move-guard.js、staging.js 和 PowerShell 回收站桥接脚本。2.4.4 的变更记录日期为 2026 年 11 月 25 日。
GitHub

一、优先修复的安全问题
P0：\\?\ 路径前缀可能绕过保护目录检查
这是本次审查中最明确的路径校验问题。

move-guard.js 在检查目标时，使用 Node 的 resolve() 规范化路径，然后检查盘符根目录、Windows 目录、Program Files、回收站目录，以及工作区根目录和其祖先目录。
raw.githubusercontent.com
 但它没有在这一步移除 \\?\ 前缀。

与之相反，PowerShell 桥接脚本的 Resolve-NormalizedPath 会主动移除这个前缀，再把结果交给 SHFileOperationW。
raw.githubusercontent.com


这造成了一个危险的不一致：
阶段	\\?\C:\workspace 的处理
Node 路径检查	仍然是 \\?\C:\workspace
工作区根目录比较	无法与 C:\workspace 正常匹配
PowerShell 桥接	去掉前缀，变成 C:\workspace
实际回收操作	操作真正的工作区目录

我使用 Node 的 path.win32.resolve() 和 path.win32.relative() 对这类路径进行了独立验证。对于 \\?\C:\workspace，相对于 C:\workspace 得到的结果仍然是一个绝对路径，因此当前 isStrictlyWithin() 判断不会把它认定为工作区本身或其子路径。

例如，正常路径 C:\workspace 会被工作区根目录保护规则拒绝；但带扩展前缀的 \\?\C:\workspace 有机会通过检查，随后在 PowerShell 阶段被转换成真正的工作区路径。

这不仅影响工作区根目录，也可能影响 \\?\C:\Windows\...、\\?\C:\Program Files\... 等原本应受保护的目标。

值得注意的是，2.4.3/2.4.4 的变更记录已经专门处理过 \\?\ 前缀导致的 UNC 误判和回收失败，但修正集中在 PowerShell 桥接及网络路径识别，并没有同步到 move-guard.js 的目标校验入口。
GitHub+2


建议：在 validateTrashTarget() 的入口处统一做路径规范化，然后再执行所有安全检查。 对 \\?\C:\... 和 \\?\UNC\server\share\... 分别转换成普通本地路径和普通 UNC 路径。之后，安全检查、工作区判断、网络路径判断和最终执行都必须使用同一个规范化结果。不要让 Node 和 PowerShell 各自维护一套不同的规范化逻辑。

至少补充以下测试：
\\?\C:\workspace
\\?\C:\workspace\subdir
\\?\C:\Windows
\\?\C:\Program Files
\\?\C:\$Recycle.Bin
\\?\UNC\server\share
\\?\UNC\server\share\folder


这些目标应当和不带前缀的对应路径得到完全一致的安全判定。
P0：file_trash 无法证明文件真的进入了回收站
这是另一个直接影响插件核心承诺的问题。

当前 PowerShell 桥接使用 SHFileOperationW，设置了：
- FOF_ALLOWUNDO
- FOF_NOCONFIRMATION
- FOF_SILENT
- FOF_NOERRORUI
随后检查 API 返回码、fAnyOperationsAborted，最后只检查源路径是否还存在。只要 API 返回成功且源路径消失，就把目标计入 recycled。
raw.githubusercontent.com


问题是，微软对 FOF_ALLOWUNDO 的定义是 “如果可能，保留撤销信息”，不是无条件保证回收。微软还专门提供了 FOF_WANTNUKEWARNING，用于在删除操作将永久销毁文件而非放入回收站时发出警告。当前代码没有设置这个标志。
Microsoft Learn+1


也就是说，下面这个判断并不成立：
API 返回成功 + 原路径消失 = 文件已进入回收站


它只能证明源路径消失，不能证明存在可恢复的回收站记录。

当前 Test-RecyclableVolume() 通过 UNC 路径判断和 DriveFormat 判断来拒绝不支持回收的卷，并且已经发现过 UNC、exFAT、FAT32 上出现“文件实际永久删除，但 API 返回成功”的情况。
raw.githubusercontent.com


但是，它没有检查该卷是否禁用了回收站，也没有验证某个文件因为容量限制等原因被系统永久删除的情况。NTFS/ReFS 只能说明文件系统类型，不能单独证明当前删除一定会产生回收站记录。

这在 UNC staging 场景尤其危险。

当前网络共享删除流程是：
1. 把共享目录复制到本地 staging 目录。
2. 对复制结果做结构校验。
3. 把 staging 目录交给回收站桥接。
4. 桥接返回成功后，直接永久删除网络共享上的原件。
   raw.githubusercontent.com
如果第 3 步实际上只是永久删除了 staging 副本，但桥接程序误报成功，第 4 步仍然会删除网络共享原件。这样就可能同时失去原件和所谓的“可恢复副本”。

微软已经将 SHFileOperation 标记为被 IFileOperation 取代，并推荐使用后者；IFileOperation 还提供了更现代的操作标志，包括优先使用的 FOFX_ADDUNDORECORD。
Microsoft Learn+1


建议：不要再把源路径消失作为回收成功的充分条件。 应当改进回收后验证，确保确实产生了回收记录；验证失败时必须保留原件并向 Agent 返回失败。对于 UNC staging，只有在确认 staging 副本确实进入可恢复状态后，才允许删除共享原件。

在 Windows 真机上必须增加以下测试：回收站被禁用、单文件超过回收站容量、卷回收站容量不足、NTFS/ReFS 正常回收、回收操作被取消。这个问题修复之前，我不会把 file_trash 的成功结果视为绝对可靠的可恢复保证。
二、是否真的收得太紧：主要问题在内容改写保护
1. blockTruncatingWrites 是目前最明显的摩擦来源
这个规则实际检查两类风险：
- 先读取某个文件，再将处理结果写回同一个文件；
- 使用未检查的 $null 端点进行切片，并将切片结果写入文件。
对于第一类，代码要求出现以下任一条件才放行：覆盖前已经创建原文件备份，或者属于带显式编码声明的有限字符串替换。否则就拒绝，并要求备份原件、写入临时文件、检查结果，再覆盖原文件。
raw.githubusercontent.com+1


这个策略有充分的事故依据。尤其是 Windows PowerShell 环境下，文本编码处理不一致确实可能导致中文内容损坏。项目记录了读取 GBK 文档时使用错误编码，之后再写回，导致中文字符变成 U+FFFD 的实际案例。
raw.githubusercontent.com


问题在于，它把“可能发生数据损坏的读改写操作”整体视为需要人工建立恢复点的高风险行为。

例如：
$content = Get-Content $file -Raw
$content = $content.Replace('旧文本', '新文本')
Set-Content $file -Value $content


即使 Agent 的替换逻辑完全正确，只要它没有声明读取和写入编码，也没有先备份，仍然会被拒绝。

而真实的文档处理任务经常不是简单字符串替换。例如读取 Markdown、解析结构、调整章节顺序、重新生成内容，再覆盖原文。这些操作无法自然地归入“有限字符串替换”，但也不应该因此完全禁止。

项目自己的历史命令回放也反映了这个问题：62,131 条 shell 命令中，最初有 1,580 条被判定为需要拒绝，其中 432 条被识别为误拦截，占全部命令约 0.70%。后续规则收敛将这一数字从 432 降到了 241；剩余拦截主要集中在读取侧没有明确编码声明的操作，以及无法判断的外部脚本写入。2.4.4 又移除了五类不应该发生的拒绝。
GitHub+2


这套数据很有价值，但它来自维护者自己的机器和历史会话，并不能直接代表其他人的 DSH 工作流。更重要的是，误拦截比例虽然占总命令数量不高，却集中在读写文件的任务上。对于 Agent 来说，这恰好是高频工作类型。
2. 当前保护范围反而遗漏了部分直接清空操作
这是比误拦截更值得注意的设计问题。

WRITE_COMMANDS 已经把 Clear-Content、Set-Content、Out-File、truncate 等列为写入命令。但 analyzeOverwriteRisk() 最终只执行 uncheckedSlice() 和 inPlaceRewrite() 两类检查。
raw.githubusercontent.com+1


这意味着它重点检查的是“读了同一个文件，再写回去”，而不是所有会清空现有内容的行为。

例如：
Clear-Content .\important.md


Set-Content .\important.md -Value ''


Clear-Content 本身就是清空文件内容而不删除文件的命令，微软文档对此有明确说明。
Microsoft Learn


但它没有先读取文件，因此不会满足 inPlaceRewrite() 的同文件读写条件；也没有未断言切片端点，因此不会满足第二个条件。

所以，这种操作可能直接通过当前内容改写保护。

这里出现了明显的不对称：
- 复杂但合法的读改写操作可能被拒绝；
- 直接清空一个文档内容的操作却可能通过。
我认为这是 blockTruncatingWrites 最应该修正的地方。

建议增加一类独立的“空内容覆盖”检测。 重点识别目标文件已经存在、写入内容明确为空或者操作明确要求截断的情况，而不是把所有写入命令都当成风险。Clear-Content、空值 Set-Content、truncate -s 0 应当成为明确的回归测试对象。

另外，当前这套写入保护只发生在 shell 命令拦截路径。如果 DSH 或其他插件提供原生文件编辑工具，那么这些工具名不在 SHELL_TOOLS 映射中，会直接跳过这个 hook。
raw.githubusercontent.com+1


这意味着它不能被理解为一个覆盖整个 DSH 文件操作体系的内容完整性保护层。
3. 应当拆分配置，而不是简单关闭整个功能
现在 blockTruncatingWrites 同时控制两种性质不同的规则：
- 防止原地读改写导致的内容损坏；
- 防止未断言切片端点造成的意外截断。
两者的误伤成本和风险性质并不相同。

我建议拆成：
配置	保护目标	建议
blockInPlaceRewrite	读取唯一副本后覆盖原文件	保留，允许通过备份或安全编辑路径放行
blockUncheckedSliceWrite	未验证 $null 等切片端点造成内容截断	保留默认开启
blockEmptyWrites	对现存文件执行明确的空内容覆盖	新增，默认开启

对于原地改写，不建议直接放弃保护。更合适的方向是让 Agent 使用具备版本保护的文件编辑接口，或在 shell 覆盖前自动保存可恢复副本。

我的判断是：原地改写保护的安全目标正确，但当前规则过于依赖静态命令形状，应该从“拦截所有无法证明安全的读改写”逐渐转向“提供一个容易使用的安全写入路径”。

三、删除保护本身还有哪些盲区
1. Git 的清理操作没有进入当前守卫
当前 MAY_TOUCH_FILES 预筛选包含常见删除命令、.NET 删除 API、写入命令、解释器和部分擦除工具，但没有匹配 Git 命令。SHELL_TOOLS 虽然覆盖了多个 shell 和持久化终端，但命令最终仍然需要先通过 MAY_TOUCH_FILES 才会进入完整分类。
GitHub+1


因此：
git clean -fdx


不会因为它是文件删除命令就自动进入当前删除分类器。

这不是一个边缘命令。Git 官方文档明确说明，git clean 会删除工作区中未被版本控制的文件；使用 -x 时，还会删除被忽略的文件。
git-clean Documentation


这恰好可能摧毁 Agent 工作区中没有纳入 Git 的重要资料，例如研究材料、临时文档、人工整理的资料库、未跟踪的项目文件等。

建议把 Git 的破坏性操作作为独立类别处理：
- git clean -fd、git clean -fdx：拒绝直接执行，先执行 dry-run，再明确目标。
- git reset --hard、git restore --worktree 等：视为工作区内容破坏操作，至少要求先检查变更状态和恢复条件。
- 不要简单把这些命令替换成 file_trash。Git 的目标可能是状态集合，而不是单一文件路径，必须先明确具体受影响对象。
2. 磁盘级操作覆盖并不完整
当前已经覆盖 Format-Volume、Clear-Disk、Initialize-Disk、format 和部分擦除程序，这是正确的扩展方向。
GitHub


但 diskpart clean 没有出现在当前预筛选规则中。

微软文档明确说明，DiskPart 的 clean 会移除当前选定磁盘的分区或卷格式信息，clean all 则会将磁盘每个扇区置零，完全删除磁盘上的数据。
Microsoft Learn


因此，这类操作值得作为高风险命令加入守卫，且需要测试：
diskpart clean
diskpart clean all
diskpart /s script.txt


最后一种尤其需要注意：如果脚本内容没有进入 hook 的检查范围，外层命令本身就无法提供足够的风险信息。
3. 已存在脚本和其他工具不属于当前保护范围
SECURITY.md 对这个边界其实写得很明确：
- 运行前已经存在、且内容没有被守卫看到的脚本文件，不会被完整检查；
- 动态构造的命令可能无法由文本解析器识别；
- 不在受监控工具列表中的工具完全不会被检查；
- 拆分到多个持久化终端调用中的命令，无法从单次调用文本中完整还原。
  GitHub
这也是我认为不能继续无限增加命令正则的原因。

例如，Agent 调用：
.\cleanup.ps1


守卫能够看到的是执行脚本的命令，而不是一定能够看到脚本内部究竟执行了什么。

同理，npm run clean、第三方工具的清理功能、其他文件操作插件，不能仅依赖当前 shell 文本分类器保证安全。

这不是继续添加若干正则表达式就能彻底解决的问题。

SECURITY.md 已经正确把插件定位为工具调用策略层，而不是 filesystem sandbox。这个定位应该保留。
GitHub


四、Windows 路径与网络共享方面的其他问题
1. 映射网络驱动器没有被明确识别
目前网络路径识别主要依赖 UNC 路径，例如：
\\server\share\folder


PowerShell 桥接脚本的 Test-RecyclableVolume() 也主要通过 UNC 形式和 DriveFormat 判断是否能回收。它没有显式检查 DriveInfo.DriveType.Network。
GitHub+1


而微软的 DriveType 枚举明确区分 Fixed 与 Network。
Microsoft Learn


因此，映射为 Z:\ 的 SMB 网络盘没有被明确纳入网络共享 staging 流程。它是否被误认为本地可回收卷，需要在 Windows 上用实际 SMB 映射盘验证；但代码层面确实缺少这一层判断。

建议明确检查：
$driveInfo.DriveType -eq [System.IO.DriveType]::Network


凡是网络驱动器都应该进入与 UNC 相同的处理路径，或者直接拒绝，不能仅凭远端文件系统返回 NTFS 就认为它具有本地回收站语义。
2. UNC staging 的“校验”并不等于内容完整性校验
这一部分实现思路是合理的：
扫描原始目录
    ↓
复制到本地 staging
    ↓
比较复制结果
    ↓
将 staging 副本送入回收站
    ↓
永久删除网络共享原件


并且代码对 reparse point、空间不足、复制失败等情况做了拒绝处理。
GitHub+2


但是，目前 walkTree() 记录的是：
- 相对路径；
- 文件或目录类型；
- 文件大小。
它并不比较文件内容哈希。项目自己的变更记录也明确说明，50 GB 目录的 staging 校验没有计算内容哈希。
GitHub+1


因此，两个文件只要路径、类型和大小一致，就可能通过当前的结构校验，即便内容发生了变化。

还存在并发修改问题：原始目录的结构信息是在复制前取得的，复制完成后，程序比较的是之前的结构信息与 staging 副本，并没有在删除原件前再次对原始目录做完整校验。

例如，复制完成后、原件删除前，网络共享中的文件被其他程序修改了，但 staging 中仍然是旧内容。原件最后被删除时，最新内容就不在 staging 副本里。

这不是常见的静态文件删除场景，但网络共享可能同时被同步客户端、其他用户或后台任务访问。

我的建议是：
- 对关键数据使用内容哈希校验；
- 删除原件前重新检查源文件是否发生变化；
- 尽可能使用文件锁或共享存储提供的快照机制；
- 校验无法完成时保留原件，不要降级为“结构一致就视为安全”。
另外，UNC 删除并不是把原始文件移动到原路径所在卷的回收站，而是把副本放进本机回收站，再永久删除共享原件。项目的安全说明已经正确披露这个差异，应该继续保留。
GitHub


在哈希校验和源文件一致性检查完善之前，我倾向于把 uncRecoverableMove 默认值改为 false，让 UNC 删除默认拒绝，而不是默认自动执行这套有永久删除步骤的流程。

五、实现质量与架构评价
这里需要区分安全机制的设计质量和当前覆盖效果。
做得比较好的部分
第一，拦截路径设计清楚。

它不是简单向 Agent 注入一段“不要删除文件”的系统提示，而是在 tools/pre-execute 阶段对命令进行实际拦截，并将能够识别的删除目标转到 file_trash。这一点比依靠模型自觉遵守提示词可靠得多。
GitHub


第二，已经意识到工具覆盖面的完整性问题。

例如，早期版本遗漏了持久化终端，导致 terminal_send 可以绕过保护；后续将 terminal_send、terminal_write 纳入检查，并对不明确的终端后端同时使用 PowerShell 和 Bash 规则进行分类。
GitHub


第三，2.4.4 的修正并不是简单增加拦截规则。

它同时修正了多个绕过路径和误拒绝案例，包括 .NET 删除方法、嵌套 shell、编码命令、Start-Process 参数顺序，以及仅仅在文本中提及擦除工具名称所导致的误判。
GitHub+2


第四，测试数量和测试结构比较扎实。

2.4.4 记录了 211 个测试，覆盖 14 个测试层。尤其是新增的结构性测试：一类验证分类器产生的拒绝结果确实经过 hook；另一类把绕过形态与应该放行的近似命令配对，防止修复一个绕过时又误伤正常操作。
GitHub


这比只维护一批危险命令正例要好得多。
仍然存在的架构性限制
现在的 shell-text.js 是一个手工编写的文本切分和 token 化器，不是真正的 PowerShell AST 解析器。它通过字符扫描识别引号、分号、管道、花括号和换行，再把结果拆成类似 argv 的 token。
GitHub+1


这是一种合理的轻量实现，但 PowerShell 本身具有复杂的语法结构，包括转义、here-string、子表达式、脚本块、参数绑定和动态调用。只靠文本扫描，很难长期保证所有组合都正确。

项目的历史变更也多次说明了这一点：同一个删除操作经过不同的括号、脚本块、启动器参数顺序或编码形式，就可能改变分类结果。
GitHub


我不建议为了追求更高覆盖率，不断把 guard.js 扩成一套越来越庞大的正则表达式集合。

更合适的方向是：
- 对 PowerShell 使用真正的 PowerShell 语法解析能力，优先考虑 System.Management.Automation.Language.Parser.ParseInput()。
- 对 Bash 采用相应的语法解析方案，而不是把 PowerShell 和 Bash 继续压进同一种文本切分模型。
- 对无法可靠解析的命令保留拒绝机制，但拒绝理由应当明确指出“命令无法可靠判定”，而不是错误地告诉 Agent 某个具体文件即将被删除。
- 对 cmd 和外部工具，明确它们的分析边界。不要假设 PowerShell AST 能解决其他命令解释器的语义。
另外，静态命令解析和 Windows 文件系统行为是两个独立问题。即使分类器完全正确，路径解析、权限、卷类型、回收站配置和并发修改仍然需要独立验证。

六、我建议的调整方案
我会把这个插件明确拆成三个保护层，而不是继续让所有规则共用一个“删除保护”的概念。
保护层	应该处理的对象	策略
删除保护	Remove-Item、rm、del 等明确删除操作	保持严格，识别后转 file_trash
不可恢复操作保护	永久擦除、清空回收站、磁盘格式化、Git 清理等	直接拒绝，必要时要求用户介入
内容完整性保护	原地覆盖、空内容写入、错误切片、脚本生成内容后覆盖原件	独立规则，优先提供备份或安全写入路径

具体配置我建议这样调整：
当前配置	建议
blockDestructiveCommands	保持默认开启，不建议放宽
forbidEmptyRecycleBin	保持默认开启
forbidWipe	保持默认开启，并补充 diskpart 等缺失操作
blockScriptDeletes	保持开启，但明确它只覆盖能够检查到的命令内容
blockTruncatingWrites	拆分成原地改写和不安全切片两项
uncRecoverableMove	暂时默认关闭，待回收结果验证和 staging 完整性校验增强后再考虑默认开启

当前最值得立即修改的顺序
优先级	修改内容	原因
P0	统一 \\?\ 路径规范化与安全校验	避免工作区根目录及系统目录保护被绕过
P0	验证真正进入回收站，而不是只检查源路径消失	防止永久删除被报告为成功
P1	增加 git clean、diskpart clean 等规则	补齐高危间接删除和磁盘操作
P1	增加 Clear-Content、空值覆盖、零长度截断保护	避免最直接的文档清空绕过
P1	识别映射网络驱动器	避免 SMB 网络盘被当成本地盘处理
P1	增强 UNC staging 的完整性校验	避免复制结果与原件不一致
P2	拆分 blockTruncatingWrites	降低对正常文件编辑任务的干扰
P2	改善 shell 语法解析	减少对复杂 PowerShell 命令的误判
P2	补充 Windows 实际环境回归测试	验证代码逻辑与系统实际行为一致

最终判断
我认为这个插件的核心方向值得保留，而且它已经不只是一个简单的危险命令拦截器：它实际上在尝试建立 Agent 文件操作的可恢复性机制。

但目前存在一个需要优先解决的矛盾：

它对某些正常的文件改写操作限制得很严格，却还不能证明每一次被报告为成功的回收操作都真的可恢复。

这比单纯的误拦截更值得担心。

我的建议不是降低整个插件的保护等级，而是：
1. 让删除拦截保持严格；
2. 修复路径校验和回收结果验证这两个核心问题；
3. 把内容覆盖保护拆分，避免正常的文档处理任务被统一阻断；
4. 对无法通过文本分析覆盖的工具和脚本，明确依赖操作系统级权限、快照或版本历史，而不是让插件承担无法完成的保证。
最后说明审查边界：本次完成的是源码审查、Windows 路径语义验证和微软 API 文档核对，没有在你的 Windows DSH 实例中执行真实删除操作。因此，映射网络驱动器、回收站禁用和容量限制等问题仍需要 Windows 端到端测试确认；上面列出的路径前缀校验不一致则已经可以从当前代码路径和 Node Windows 路径语义中直接推导出来。