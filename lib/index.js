/**
 * dsh-delete-guard — force every DSH file deletion through the OS Recycle Bin.
 *
 * Where this hooks
 * ----------------
 * `tools/pre-execute` (a waterfall on `ctx.tools`). That is the seam DSH 0.1.7
 * actually routes every model tool call through, and `PreToolDecision` there can
 * return `{ kind: 'deny' }`.
 *
 * It deliberately does NOT monkey-patch the shell executor. `ctx.shell` in 0.1.7
 * is a `ShellExecutor` with only `resolve()` and `execute()`; there is no
 * `run()`/`start()` to wrap, so a wrapper installed there is never consulted and
 * every delete proceeds unguarded while appearing protected.
 *
 * What it does with a delete
 * --------------------------
 * A recognised delete is not merely denied: the operands are parsed out and the
 * call is denied with a message instructing the model to re-issue the deletion
 * through the `file_trash` tool this plugin registers, which performs a real
 * `SHFileOperationW(FOF_ALLOWUNDO)` move. Pre-execute cannot rewrite arguments
 * (`ToolExecution.arguments` is frozen and already logged), so denial plus a
 * redirect is the correct shape.
 *
 * Known limits, stated honestly
 * -----------------------------
 * A delete executed *inside* a script body is not rewritten. `blockScriptDeletes`
 * denies inline `-Command`/`-File`/`-e` invocations that contain delete verbs,
 * but a script file whose contents the guard never sees can still erase data if
 * the model writes one and runs it by a path that contains no delete verb. The
 * system-prompt section asks the model not to; that part is guidance, not a
 * guarantee.
 */

import { stat } from 'node:fs/promises';
import z from '@deepseek-ai/schemastery';
import { classifyCommand, parseDeleteStatement, splitStatements } from './guard.js';
import { recyclePaths, recycleBinUsage } from './recycle.js';
import { validateTrashTarget, workspaceRootReason } from './move-guard.js';
import { defaultStagingRoot, isNetworkPath, stageForRecycle } from './staging.js';

export const name = 'delete-guard';
export const inject = ['tools', 'systemPrompt'];

/** Tool name the model must use for every deletion. */
const TRASH_TOOL = 'file_trash';
/** Tool name for reporting recycle-bin state. */
const STATUS_TOOL = 'trash_status';
/** System-prompt section identifier. */
const PROMPT_SECTION = 'delete-guard';
/** Ordering hint for the prompt section. */
const PROMPT_ORDER = 60;

/**
 * Tools that carry a shell command, and where the command text lives.
 *
 * The guard used to look at `pwsh` and `bash` only, which left DSH's persistent
 * terminal uncovered: `terminal_send` types a command into a live PTY, so it
 * never passes through either shell tool. Measured 2026-10-23 in this install —
 * `terminal_send` ran `Remove-Item …` while the guard sat on the same call path
 * and said nothing.
 *
 * `dialect` decides two rules: `$( … )` opacity (pwsh-only) and POSIX path
 * translation (bash-only).
 *
 * `ambiguous: true` means "the tool does not say which shell this runs in" — a
 * persistent terminal types text into a PTY whose backend the send call does not
 * report. Those are judged under **both** dialects and the verdicts combined; see
 * `classifyAcrossShells`.
 *
 * An earlier version simply judged them as `pwsh`, on the reasoning that it "refuses
 * more, not less". Measured 2026-11-24: that holds for `$( … )` and fails for POSIX
 * paths — `rm /tmp/x` is `deny` under bash and `rewrite` under pwsh, the opposite
 * way round. Neither dialect dominates, so neither can stand in for the other.
 */
const SHELL_TOOLS = new Map([
  ['pwsh', { field: 'command', dialect: 'pwsh' }],
  ['powershell', { field: 'command', dialect: 'pwsh' }],
  ['cmd', { field: 'command', dialect: 'pwsh' }],
  ['bash', { field: 'command', dialect: 'bash' }],
  ['sh', { field: 'command', dialect: 'bash' }],
  ['zsh', { field: 'command', dialect: 'bash' }],
  ['shell', { field: 'command', dialect: 'bash', ambiguous: true }],
  ['terminal_send', { field: 'text', dialect: 'pwsh', ambiguous: true }],
  ['terminal_write', { field: 'text', dialect: 'pwsh', ambiguous: true }],
]);

/**
 * A cheap "could this command possibly touch files, the bin, or an interpreter?"
 * test, used to skip the full classifier.
 *
 * Must be **over-inclusive**: every rule in `guard.js` needs at least one of these
 * signals to fire, so anything this misses is a command that no rule could have
 * matched anyway. The cost of a false positive is a few hundred microseconds; the
 * cost of a false negative would be an unguarded command.
 *
 * That claim was false and nothing checked it. `[System.IO.File]::Delete(…)` is
 * refused by the classifier — `test/guard.test.mjs` asserts so — and this filter did
 * not match it, so the hook returned `next()` and the host ran the delete. The
 * refusal existed on a path that never executes. Measured 2026-11-25: 5 of 5 .NET
 * delete spellings were allowed by the hook and denied by the classifier.
 *
 * The fix has two halves. The signals below now cover the erase-API family; and
 * `test/kind-matrix.test.mjs` drives one representative of every classifier kind
 * through this filter, so a rule added without a signal fails a test instead of
 * quietly dropping out of the only path that runs.
 */
export const MAY_TOUCH_FILES = new RegExp([
  // delete verbs
  '\\b(?:Remove-Item|ri|del|erase|rd|rmdir|rm|unlink|clear-content)\\b',
  // .NET erase APIs. Keyed on the call, matching `ERASE_CONSTRUCTS`: `::Exists` and
  // `::ReadAllBytes` name the same types and erase nothing.
  '::\\s*(?:Delete|DeleteFile|DeleteDirectory)\\s*\\(',
  '\\.\\s*Delete\\s*\\(\\s*(?:\\)|\\$?(?:true|1)\\s*[,)])',
  // write verbs and redirects
  '\\b(?:Set-Content|Out-File|Add-Content|Export-Csv|Tee-Object|Copy-Item|Move-Item|New-Item|::Write\\w+|::Create\\w*)\\b',
  '>{1}(?!>)',
  // Writes that are not PowerShell cmdlets. Their rules live in `rewrite-guard.js`
  // (`WRITE_COMMANDS`), and without a signal here the hook returned before the classifier
  // ran: `sed -i 's/a/b/g' f`, `truncate -s 0 f`, `cat f | tee f` and `cp /dev/null f`
  // reached the host untouched while the same act spelled with a cmdlet was refused
  // (measured 2026-11-26). `README` promised `sed -i` was covered.
  '\\b(?:sed|truncate|dd|tee|cp|mv|diskpart)\\b',
  // readers (they matter to the in-place rule)
  '\\b(?:Get-Content|ReadAllText|ReadAllLines|Import-Csv|Select-String|OpenText)\\b',
  // interpreters, inline bodies, opaque constructs
  '\\b(?:bash|sh|zsh|pwsh|powershell|node|python|python3|perl|ruby|cmd(?:\\.exe)?)\\b',
  '\\$-{0,1}\\(|`|<<|\\bxargs\\b|\\bfind\\b',
  // script text assembled at run time: equivalent to `Invoke-Expression`
  '\\bscriptblock\\b',
  // trash / wipe / bin surfaces
  '\\b(?:sdelete|sdelete64|shred|srm|wipe|cipher|format|robocopy|Invoke-Expression|iex|Add-Type)\\b',
  // PowerShell Storage cmdlets erase a whole volume/disk without a file verb
  '\\b(?:Format-Volume|Clear-Disk|Initialize-Disk)\\b',
  // `git` destroys working-tree content without naming a delete verb: `git clean`,
  // `git rm`, `git reset --hard`, `git checkout -- <path>`, `git restore <path>`.
  // The rules live in `guard.js` (`gitDestroysWorktree`); the signal has to be here or
  // the hook returns before them — which is how 2.4.5 shipped a `git clean -fd` rule
  // that never ran (measured 2026-11-26).
  '\\bgit\\b[^\\n;&|]*\\b(?:clean|rm|reset|checkout|restore)\\b',
  'recycle|namespace\\(\\s*(?:10|0xa)\\s*\\)|invokeverb|\\bdoit\\b|\\.verbs\\s*\\(|shemptyrecyclebin',
].join('|'), 'i');

/**
 * Classify a command under every shell it could be running in, and combine the
 * verdicts conservatively.
 *
 * A persistent terminal does not report its backend, so the shell behind the text is
 * unknown. Judging it as one dialect is a guess, and measurement showed the guess has
 * no safe default: `rm /tmp/x` is `deny` under bash and `rewrite` under pwsh, while
 * `Remove-Item $(…)` is the other way round. Whichever single dialect is chosen, some
 * command slips through that the other would have refused.
 *
 * So both run, and the results are merged:
 *
 *   any deny         -> deny. A refusal under either shell names a real risk.
 *   both rewrite, different targets -> deny. The same text means two different files;
 *                       that is not something to resolve by preference.
 *   otherwise        -> the rewrite that was found, or allow if neither fired.
 *
 * The ambiguity denial is actionable on purpose: it tells the caller to write the
 * Windows path, which is the one spelling both shells read the same way.
 *
 * @param command - the text about to be typed into the terminal.
 * @param options - classifier options (`forbidEmptyRecycleBin` and friends).
 * @returns a single verdict in the shape `classifyCommand` returns.
 */
function classifyAcrossShells(command, options) {
  const verdicts = ['pwsh', 'bash'].map((dialect) => classifyCommand(command, { ...options, dialect }));

  const denied = verdicts.find((v) => v.action === 'deny');
  if (denied !== undefined) return denied;

  const rewrites = verdicts.filter((v) => v.action === 'rewrite');
  if (rewrites.length === 0) return verdicts[0];

  if (rewrites.length === 2) {
    const key = (v) => [...v.targets].sort().join('\u0000');
    if (key(rewrites[0]) !== key(rewrites[1])) {
      return {
        action: 'deny',
        kind: 'opaque',
        reason:
          'Refusing a delete whose target means two different things: the terminal does not report which '
          + `shell it runs, and this path is ${rewrites[0].targets.join(', ')} in PowerShell but `
          + `${rewrites[1].targets.join(', ')} in Git Bash. Write the Windows path (\`C:\\…\`) and hand that to `
          + '`file_trash` so the target is unambiguous.',
      };
    }
  }
  return rewrites[0];
}

/**
 * Reject an empty path list before any I/O.
 * @param paths - candidate paths.
 * @returns the non-empty trimmed list.
 */
/**
 * The array a string spells as JSON, or `undefined` when it spells none.
 *
 * `[notes].txt` is a legal Windows file name and does not parse, so it stays one path.
 *
 * @param text - the string that arrived in `paths`.
 * @returns the array it spells, or `undefined`.
 */
function spelledPathList(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined;
  try {
    const value = JSON.parse(trimmed);
    return Array.isArray(value) && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn whatever arrived in `paths` into a list of non-empty path strings.
 *
 * The parameter has one meaning — one or more paths — and several spellings reach here: an
 * array, a bare string, an array serialised into its own JSON text, and nestings of those.
 *
 * Classifying the spellings does not converge. Each one needed its own branch, and the
 * branch that was missing is the one that failed in use: a bare string was discarded, then
 * a JSON-text array was treated as one long file name, and a third would have followed. So
 * the shape is not classified — a string is either JSON that spells a list, or one path; an
 * array is its elements, recursed; anything else contributes nothing.
 *
 * This is deliberately more permissive than the declared schema. The schema says `array`
 * because that is what the model should send; the host does not validate it (`ctx.tools.
 * register` passes arguments through verbatim — only `defineTool` checks), so a slip or an
 * adapter that serialises array arguments has to be absorbed here or it costs the caller a
 * turn. Measured 2026-11-25: a bare string cost four retries of the same request, and a
 * JSON-text array failed at a path made of its own punctuation.
 *
 * @param value - whatever was put in `paths`.
 * @param depth - recursion guard.
 * @returns the usable paths, flattened and trimmed.
 */
function asPathList(value, depth = 0) {
  if (depth > 4) return [];
  if (typeof value === 'string') {
    const spelled = spelledPathList(value);
    if (spelled !== undefined) return asPathList(spelled, depth + 1);
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(value)) return value.flatMap((entry) => asPathList(entry, depth + 1));
  return [];
}

/**
 * Say what arrived in `paths`, precisely enough that the caller can fix it.
 *
 * A refusal is only actionable if it names the difference between what was sent and
 * what was wanted. "No usable paths were supplied" named neither.
 *
 * @param value - whatever the model put in `paths`.
 * @returns a short noun phrase.
 */
function describePathsArgument(value) {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.trim().length === 0 ? 'a blank string' : `the string ${JSON.stringify(value)}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 'an empty array';
    // The array produced no paths, so nothing in it was a non-blank string.
    return `${value.length} entries, none a usable path`;
  }
  return `a value of type ${typeof value}`;
}

/**
 * Whether one statement is a dry run (`-WhatIf`).
 *
 * Token-level on purpose. A textual test is fooled by the word appearing in a
 * comment or inside a string value — measured 2026-11-24: with a textual test,
 * `Set-Content $f $t  # always -WhatIf first` and
 * `Set-Content -Value "run -WhatIf then finish"` were both treated as dry runs even
 * though they really write.
 *
 * `-WhatIf:$false` / `-WhatIf:$true` are **not** dry runs: the first really executes,
 * and neither is the bare preview the switch is for.
 *
 * @param statement - one statement of the command.
 * @returns whether that statement would only preview.
 */
function isDryRun(statement) {
  if (typeof statement !== 'string' || !/-whatif/i.test(statement)) return false;
  for (const line of statement.split(/\r?\n/)) {
    // Strip a trailing PowerShell comment so `… -WhatIf` in prose does not count.
    const code = line.replace(/(?:^|\s)#.*$/, '');
    // A `-WhatIf` token that is not followed by a `:` (i.e. not `:$false`).
    if (/(?:^|\s)-whatif(?![:\w-])/i.test(code)) return true;
  }
  return false;
}

/**
 * Resolve the workspace root the sandbox policy reports, falling back to the
 * process working directory. The fallback matters: without a sandbox service
 * the `file_trash` path would have no root to compare against, and the guard
 * would silently lose its workspace check.
 * @param ctx - the Cordis context.
 * @returns an absolute path, or `undefined` when nothing resolved.
 */
function resolveWorkspaceRoot(ctx) {
  try {
    const value = ctx.sandboxPolicy?.resolve?.({})?.workspaceRoot;
    if (typeof value === 'string' && value.trim().length > 0) return value;
  } catch {
    // Absent or misbehaving policy service: fall back rather than skip the check.
  }
  return process.cwd();
}

/**
 * Plugin configuration, as a schema rather than a set of untyped keys.
 *
 * Every key defaults to on. That is deliberate and it was already true — the
 * destructuring defaults below mean an omitted key reads as `true`, not `false`, so a
 * manifest that forgets one does not silently remove a rule. What the schema adds is
 * the other half: a typo is reported instead of being coerced, and `stagingRoot` is
 * discoverable, which it was not — it worked but appeared nowhere the user could see.
 */
export const Config = z.object({
  enabled: z.boolean().default(true)
    .description('总开关。关掉后插件不注册任何东西，包括 file_trash 工具'),
  blockDestructiveCommands: z.boolean().default(true)
    .description('拦截 shell 里的删除命令，改为要求使用 file_trash'),
  forbidEmptyRecycleBin: z.boolean().default(true)
    .description('拦截清空回收站（Clear-RecycleBin / SHEmptyRecycleBin / 回收站 shell 动词）'),
  forbidWipe: z.boolean().default(true)
    .description('拦截永久擦除工具（sdelete / shred / srm / cipher /w / format / 磁盘 cmdlet）'),
  blockScriptDeletes: z.boolean().default(true)
    .description('拦截在子进程或运行时构造的字符串里执行的删除（bash -c / Invoke-Expression / scriptblock）'),
  blockTruncatingWrites: z.boolean().default(true)
    .description('拦截把唯一副本读进来再覆盖回去的整档重写，以及未断言的切片端点（兼容键：未单独设置下面两项时对它俩都生效）'),
  blockInPlaceRewrite: z.boolean().default(true)
    .description('拦截「读同一文件再覆盖回去」的整档重写'),
  blockUncheckedSliceWrite: z.boolean().default(true)
    .description('拦截未断言端点（$idx ± n）的切片 + 写文件'),
  blockEmptyWrites: z.boolean().default(true)
    .description('拦截把文件写成空内容的命令（Clear-Content、空值 Set-Content、truncate -s 0、裸重定向）'),
  uncRecoverableMove: z.boolean().default(true)
    .description('网络共享上的删除：先复制到本地 NTFS 卷、校验、回收副本，再删原件'),
  stagingRoot: z.string()
    .description('网络共享删除的中转目录；缺省用系统临时目录下的专用子目录'),
});

/**
 * Plugin entry point.
 * @param ctx - the Cordis context.
 * @param config - plugin configuration.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return;

  const {
    blockDestructiveCommands = true,
    forbidEmptyRecycleBin = true,
    forbidWipe = true,
    blockScriptDeletes = true,
    blockTruncatingWrites = true,
    blockEmptyWrites = true,
    uncRecoverableMove = true,
    stagingRoot,
  } = config;

  // The two content rules are separately switchable, and the older single key still works:
  // a profile that wrote `blockTruncatingWrites: false` keeps both off unless it names them.
  const blockInPlaceRewrite = config.blockInPlaceRewrite ?? blockTruncatingWrites;
  const blockUncheckedSliceWrite = config.blockUncheckedSliceWrite ?? blockTruncatingWrites;

  // Turning a rule off is the user's call, so it is allowed — but silently is not:
  // this plugin exists to be the last line, and a rule turned off by an edit made for
  // a different reason leaves nothing behind to notice it.
  for (const [key, value] of Object.entries({
    blockDestructiveCommands,
    forbidEmptyRecycleBin,
    forbidWipe,
    blockScriptDeletes,
    blockTruncatingWrites,
    blockInPlaceRewrite,
    blockUncheckedSliceWrite,
    blockEmptyWrites,
    uncRecoverableMove,
  })) {
    if (value === false) ctx.logger?.warn?.(`[dsh-delete-guard] ${key} is disabled by configuration`);
  }

  const guardOptions = {
    forbidEmptyRecycleBin,
    forbidWipe,
    blockScriptDeletes,
    blockInPlaceRewrite,
    blockUncheckedSliceWrite,
    blockEmptyWrites,
  };
  const workspaceRoot = resolveWorkspaceRoot(ctx);
  const stageRoot = typeof stagingRoot === 'string' && stagingRoot.trim().length > 0
    ? stagingRoot.trim()
    : defaultStagingRoot();

  // --- 1. Intercept destructive shell commands ------------------------------

  if (blockDestructiveCommands) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      // Only the tools that carry a shell command: the two shell tools plus the
      // persistent terminal, which types into a live PTY.
      const spec = SHELL_TOOLS.get(exec.name);
      if (spec === undefined) return next();

      const args = exec.arguments;
      if (args === null || typeof args !== 'object') return next();
      const command = args[spec.field];
      if (typeof command !== 'string') return next();

      // Cheap precondition: a command that cannot possibly delete or destroy content
      // is not worth the full classifier.
      //
      // The classifier is ~250 µs on a long command (dozens of regexes over the whole
      // text), which is real money on the tool-call path — the host pays it before
      // every shell call. Two regexes cost ~1.8 µs and skip 88% of commands: measured
      // on 6,000 real commands, only 11.6% mention both a reader and a writer.
      //
      // Deliberately over-inclusive: any mention of a delete verb, a write verb, a
      // redirect, an interpreter, or a bin API lets the command through to the full
      // check. A false positive here only costs time; a false negative would skip the
      // guard, so the net is wide.
      if (!MAY_TOUCH_FILES.test(command)) return next();

      // The tool name identifies the shell language, which decides dialect-scoped
      // rules such as `$( … )` and POSIX path translation. When the tool does not say
      // which shell it is (a terminal), both are tried and the verdicts combined.
      const verdict = spec.ambiguous === true
        ? classifyAcrossShells(command, guardOptions)
        : classifyCommand(command, { ...guardOptions, dialect: spec.dialect });

      if (verdict.action === 'allow') return next();

      if (verdict.action === 'deny') {
        return {
          kind: 'deny',
          reason: verdict.reason,
          info: { name: 'DeleteGuardError', code: `DELETE_GUARD_${verdict.kind.toUpperCase()}` },
        };
      }

      // action === 'rewrite': steer the model to the recoverable path.
      const list = verdict.targets.map((t) => `"${t}"`).join(', ');

      // A dry run must not be turned into an instruction to really delete.
      //
      // Measured 2026-11-24: `Remove-Item -LiteralPath x.txt -WhatIf` classified as
      // `rewrite/delete`, and this branch told the model to re-run it as `file_trash`
      // — i.e. the user asked to preview and the guard advised destroying the file.
      // That is a safety inversion, not a false positive.
      //
      // Judged **per statement**: a command whose every delete carries `-WhatIf` deletes
      // nothing, so it is let through untouched — blocking a preview protects nothing and
      // costs a round (measured 2026-11-26: `Remove-Item -WhatIf x` was denied). A command
      // that mixes a preview with a real delete is still refused, because one deny covers
      // the whole call and the rewrite instruction would name the previewed path too.
      const statementList = splitStatements(command);
      const deletes = statementList.filter((statement) => parseDeleteStatement(statement) !== undefined);
      const dryDeletes = deletes.filter((statement) => isDryRun(statement));
      if (deletes.length > 0 && dryDeletes.length === deletes.length) return next();
      if (dryDeletes.length > 0) {
        return {
          kind: 'deny',
          reason:
            'Part of this command is a preview (`-WhatIf`) and part is not: the previewed statement deletes nothing, '
            + 'and the rest would. The guard blocks the call as a whole, so run the preview on its own and send the '
            + `real delete through ${TRASH_TOOL} (${list}).`,
          info: { name: 'DeleteGuardError', code: 'DELETE_GUARD_DRY_RUN' },
        };
      }

      return {
        kind: 'deny',
        reason:
          `The recycle-bin guard blocked this delete. Deleting through the shell erases files permanently, ` +
          `so all deletions must go through the ${TRASH_TOOL} tool, which moves them to the OS Recycle Bin ` +
          `where they stay recoverable.\n\n` +
          `Re-run this as:  ${TRASH_TOOL} with paths = [${list}]\n\n` +
          `If those paths are wrong or you meant a different target, read the directory first and re-issue ` +
          `the call with explicit literal paths.`,
        info: { name: 'DeleteGuardError', code: 'DELETE_GUARD_REWRITE' },
      };
    });
  }

  // --- 2. The tool the model must use instead -------------------------------

  ctx.tools.register({
    name: TRASH_TOOL,
    description:
      'Delete files or directories by moving them to the OS Recycle Bin, where they remain recoverable. ' +
      'This is the only permitted way to delete anything. Never use pwsh/bash with Remove-Item, del, rm, rd or rmdir. ' +
      'The operation fails loudly rather than falling back to a permanent erase.',
    // `ctx.tools.register` passes parameters through verbatim (only `defineTool`
    // compiles the flat DSL), so hand-write standard JSON Schema here — the
    // model endpoint rejects the un-compiled flat map with 11129.
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paths: {
          type: 'array',
          description:
            'Absolute or workspace-relative paths. A Windows path (`C:\\tmp\\x`) is read as written. '
            + 'Git Bash spellings are accepted too: `/c/tmp/x` and `/cygdrive/c/tmp/x` are both read as '
            + '`C:\\tmp\\x`. An extended-length `\\\\?\\` prefix is accepted and normalised; `\\\\?\\Volume{…}` '
            + 'and `\\\\.\\` device paths are refused. `~`, `/tmp` and `/usr` are refused, because nothing here '
            + 'can resolve them to a real location — pass the Windows path instead.',
          items: { type: 'string' },
        },
        reason: {
          type: 'string',
          description: 'Optional short note on why these paths are being deleted.',
        },
      },
      required: ['paths'],
    },
    output: {
      // Raw JSON Schema (not the authoring DSL): `required` is an object-only
      // key here. It must be an array of property names on the object, never a
      // per-node flag — the host rejects `required` on array/string nodes.
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['recycled', 'staged', 'failures'],
        properties: {
          recycled: { type: 'array', items: { type: 'string' } },
          // Items deleted from a volume with no Recycle Bin (a UNC share): the
          // content was copied to a local NTFS volume, verified, recycled there,
          // and only then removed from its original location. Reported apart from
          // `recycled` because the original path is *not* in the bin — its
          // content is.
          staged: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'staged', 'recycled', 'sourceRemoved'],
              properties: {
                path: { type: 'string' },
                staged: { type: 'string' },
                recycled: { type: 'boolean' },
                sourceRemoved: { type: 'boolean' },
                verification: { type: 'string' },
                remaining: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          failures: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'error'],
              properties: {
                path: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [];
        if (value.recycled.length > 0) {
          lines.push(`Moved to the Recycle Bin (${value.recycled.length}):`);
          for (const p of value.recycled) lines.push(`  ${p}`);
        }
        if (value.staged.length > 0) {
          lines.push(`Deleted from a location with no Recycle Bin (${value.staged.length}):`);
          for (const s of value.staged) {
            lines.push(`  ${s.path}`);
            lines.push(`    content copied to ${s.staged} and recycled from there (verified: ${s.verification ?? 'n/a'})`);
            lines.push(
              s.sourceRemoved
                ? `    the original at that share was removed after the copy was verified — the share has no Recycle Bin, `
                  + 'so restoring means finding this entry in the local Recycle Bin, whose original location is the staging path'
                : `    ⚠ the original is still there: removing it failed${s.remaining?.length ? ` (${s.remaining.join(', ')})` : ''}`,
            );
          }
        }
        if (value.failures.length > 0) {
          lines.push(`Failed (${value.failures.length}):`);
          for (const f of value.failures) lines.push(`  ${f.path}: ${f.error}`);
        }
        if (lines.length === 0) lines.push('Nothing was deleted: no usable paths were provided.');
        lines.push('');
        lines.push('Items reported above are recoverable from the local Recycle Bin; they were not permanently erased.');
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const paths = asPathList(args.paths);
      if (paths.length === 0) {
        // Say what arrived and what was wanted. "No usable paths were supplied" told the
        // caller nothing it could act on: it could not tell an empty list from a typo in
        // the field name, and had no way to learn that the shape was the problem.
        const received = describePathsArgument(args.paths);
        return {
          recycled: [],
          staged: [],
          failures: [{
            path: '(none)',
            error: `expected \`paths\` to be an array of path strings, received ${received}. `
              + 'Pass them as an array: paths = ["C:\\tmp\\x", "C:\\tmp\\y"]',
          }],
        };
      }

      // The session's working directory, as the host actually exposes it: `Session` has
      // `readonly header: SessionHeader`, and the cwd lives on that header. Reading
      // `session.cwd` always produced `undefined`, so every relative path resolved
      // against `process.cwd()` — wherever `dsh web` happened to be started — and the
      // caller was told "no such file or directory" about a file that was there.
      //
      // Measured 2026-11-25 against this installation: a relative path with
      // `agent.session.header.cwd = C:\…` resolved to the *plugin's* directory instead,
      // while the test-only shape `agent.session.cwd` resolved correctly. The tests had
      // been faking the same wrong property the code read, so the two agreed and neither
      // was checked against the host.
      //
      // Historical scale from a sweep of this machine's session logs: 431 relative-path
      // refusals, 401 of which succeeded once the caller switched to an absolute path —
      // the file had been there all along.
      //
      // `session.cwd` is kept as a fallback for callers that pass it directly (tests, and
      // any host version that exposed it), never in preference to the real one.
      const cwd = exec.agent?.session?.header?.cwd
        ?? exec.agent?.session?.cwd
        ?? process.cwd();

      // The shell-side guard can only police deletes the model runs through
      // pwsh/bash. A direct file_trash call has no command text to scan, so the
      // operands are policed here: resolve each one, refuse the filesystem
      // roots whose Recycle Bin store lives inside them, and refuse the session
      // workspace root. See move-guard.js for why a "recoverable" excuse does
      // not cover these.
      const absolute = [];
      const failures = [];
      for (const raw of paths) {
        const verdict = validateTrashTarget(raw, cwd);
        if (!verdict.ok) {
          failures.push({ path: raw, error: verdict.error });
          continue;
        }
        const rootReason = workspaceRootReason(verdict.path, workspaceRoot);
        if (rootReason !== undefined) {
          failures.push({ path: verdict.path, error: rootReason });
          continue;
        }
        // Verify existence up front so a typo is reported as a missing path
        // rather than as a shell-level failure.
        try {
          await stat(verdict.path);
          absolute.push(verdict.path);
        } catch {
          failures.push({ path: verdict.path, error: 'no such file or directory' });
        }
      }

      // A network location has no Recycle Bin, so the bridge would refuse it. When
      // staging is enabled the item is copied to a local NTFS volume, verified,
      // recycled from there, and only then removed from the share: the content is
      // recoverable, the path is not. See staging.js for the step order and for
      // what "verified" does and does not cover.
      const staged = [];
      const direct = [];
      for (const path of absolute) {
        if (!isNetworkPath(path)) {
          direct.push(path);
          continue;
        }
        if (!uncRecoverableMove) {
          failures.push({
            path,
            error: 'a network location has no Recycle Bin, so recycling here would erase the item permanently. '
              + 'Copy it to a local NTFS path first, or delete it from Explorer where Windows can warn the user.',
          });
          continue;
        }
        const outcome = await stageForRecycle(path, {
          stagingRoot: stageRoot,
          recycle: (list) => recyclePaths(list, { signal: exec.signal }),
        });
        if (outcome.ok) {
          staged.push({
            path,
            staged: outcome.staged,
            recycled: true,
            sourceRemoved: outcome.sourceRemoved,
            verification: outcome.verification,
            ...(outcome.remaining === undefined ? {} : { remaining: outcome.remaining }),
          });
          continue;
        }
        failures.push({ path, error: outcome.error });
      }

      if (direct.length === 0) {
        return { recycled: [], staged, failures };
      }

      const result = await recyclePaths(direct, { signal: exec.signal });
      return {
        recycled: result.recycled,
        staged,
        failures: [...failures, ...result.failures],
      };
    },
  });

  // --- 3. Recycle-bin reporting --------------------------------------------

  ctx.tools.register({
    name: STATUS_TOOL,
    description:
      'Report how many items and bytes currently sit in the OS Recycle Bin for a drive. ' +
      'Use this to confirm deletions landed in the bin rather than being erased.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        drive: {
          type: 'string',
          description: 'Drive letter like "C:" or "D:". Defaults to the system drive.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['drive', 'items', 'bytes'],
        properties: {
          drive: { type: 'string' },
          items: { type: 'integer' },
          bytes: { type: 'integer' },
          // Present only when the volume's bin could not be read. Without it the tool
          // reported `0 item(s), 0 B` for a failed query, which is the one answer it
          // must never give by accident: this tool exists to confirm that a delete
          // landed in the bin.
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        // `drive` already carries its colon when it came from the caller
        // (`F:`), so appending another one printed "Recycle Bin on F::".
        const drive = String(value.drive).replace(/:+$/, '');
        if (typeof value.error === 'string' && value.error.length > 0) {
          return [{
            type: 'text',
            text: `Could not read the Recycle Bin on ${drive}: ${value.error}. No count was measured — `
              + 'this is not an empty bin.',
          }];
        }
        return [{
          type: 'text',
          text: `Recycle Bin on ${drive}: ${value.items} item(s), ${formatBytes(value.bytes)}.`,
        }];
      },
    },
    async execute(args, exec) {
      const drive = typeof args.drive === 'string' && args.drive.trim().length > 0
        ? args.drive.trim()
        : undefined;
      const usage = await recycleBinUsage(drive, { signal: exec.signal });
      return {
        drive: drive ?? '(system drive)',
        items: usage.items,
        bytes: usage.bytes,
        ...(usage.error === undefined ? {} : { error: usage.error }),
      };
    },
  });

  // --- 4. System-prompt guidance -------------------------------------------

  try {
    ctx.systemPrompt.section({
      name: PROMPT_SECTION,
      order: PROMPT_ORDER,
      text: [
        '## Deletion policy: OS Recycle Bin only',
        '',
        `Every deletion goes through \`${TRASH_TOOL}\`: it moves the target to the Recycle Bin, where the user`,
        'can recover it. Anything deleted another way is gone for good. The guard therefore refuses shell',
        'deletes (`Remove-Item`, `del`, `rm`, …), including inside a persistent terminal, and the error says',
        `to call \`${TRASH_TOOL}\` instead.`,
        '',
        'Refused with no shell equivalent: emptying or modifying the bin, permanent-erase tools and',
        'disk-level erasure (`shred`, `sdelete`, `cipher /w`, `format`), and a deletion built at run time',
        `(a script, \`-Command\` / \`-enc\`, \`Invoke-Expression\`). Reach for \`${TRASH_TOOL}\` there too.`,
        '',
        'A network share has no Recycle Bin; `file_trash` stages the item to a local volume, verifies the',
        'copy, and recycles it, so it stays findable afterwards.',
        '',
        'Code you write can destroy a file without deleting it: rewriting the only copy in place, emptying it',
        '(`Clear-Content`, an empty `Set-Content`), or slicing on an unasserted endpoint (`$lines[0..($idx-1)]`',
        'with `$idx` unset silently becomes `0..-2`).',
      ].join('\n'),
    });
  } catch (error) {
    // A host without the system-prompt service still gets the enforcement half.
    ctx.logger?.warn?.('delete-guard: systemPrompt section not registered:', error.message);
  }
}

/**
 * Format a byte count for display.
 * @param bytes - the count.
 * @returns a human-readable string.
 */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export { classifyCommand } from './guard.js';
