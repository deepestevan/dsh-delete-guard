/**
 * Destructive-command detection and rewrite planning.
 *
 * This module is pure: it takes a command string and returns a verdict plus the
 * list of paths a rewrite should move to the Recycle Bin. No I/O, no ctx, so it
 * is directly unit-testable.
 *
 * Design notes
 * ------------
 * The matcher is *command-position aware*: a delete verb only counts when it
 * appears where a command can start (after a separator or at the string head).
 * That keeps `Get-Content form.txt` and `$rm = 1` from being false positives,
 * which is the failure mode of naive `/\brm\b/` guards.
 *
 * Unlike a block-only guard, a matched command is not simply denied: the parsed
 * operands are handed back so the caller can perform a real recycle-bin move.
 * Denial is the fallback for the cases where a safe rewrite cannot be proven
 * (pipelines, command substitution, `-Recurse` over an unresolved glob, etc.).
 *
 * This module judges *deletes*. Content that is destroyed without any delete
 * verb — an in-place rewrite of the only copy — is `rewrite-guard.js`; the two
 * are wired together at the bottom of `classifyCommand`.
 */

import { commandWord, maskHereStrings, splitStatements, tokenize, tokenizeSegments, unquote } from './shell-text.js';
import { analyzeOverwriteRisk } from './rewrite-guard.js';

/** PowerShell delete verbs whose operand list we can trust. */
const PS_DELETE_VERBS = ['remove-item', 'ri'];
/** PowerShell cmdlet aliases that mean the same thing. */
const PS_DELETE_ALIASES = ['del', 'erase', 'rd', 'rmdir', 'rm'];
/** POSIX delete verbs. */
const POSIX_DELETE_VERBS = ['rm', 'unlink', 'rmdir', 'shred', 'srm'];

/**
 * Delete-cmdlet parameters that consume the following token as their value.
 * Lower-cased, because the lookup is case-insensitive.
 *
 * Kept as an explicit list rather than a `-<word> <word>` heuristic: an operand
 * legitimately follows no flag at all, and guessing would swallow real targets.
 * `-Path` / `-LiteralPath` are handled separately because their value *is* the
 * target.
 */
const FLAGS_TAKING_VALUE = new Set([
  '-erroraction',
  '-ea',
  '-errorvariable',
  '-ev',
  '-warningaction',
  '-wa',
  '-warningvariable',
  '-wv',
  '-informationaction',
  '-infa',
  '-informationvariable',
  '-iv',
  '-outbuffer',
  '-ob',
  '-outvariable',
  '-ov',
  '-pipelinevariable',
  '-pv',
  '-filter',
  '-include',
  '-exclude',
  '-credential',
]);

/**
 * Common parameters that are **switches**: they take no value.
 *
 * These were listed above until 2026-11-24, which made them swallow the operand that
 * followed. Measured: `Remove-Item -Verbose C:\x\a.txt` and
 * `Remove-Item -Confirm C:\x\a.txt` both classified as "no explicit operands", so the
 * model was told its delete had no target instead of being handed the paths to
 * `file_trash`. `-WhatIf` had the same defect and, worse, turned a preview into a
 * rewrite instruction (see `isDryRun` in index.js).
 */
const SWITCH_PARAMETERS = new Set(['-confirm', '-whatif', '-verbose', '-debug']);

/**
 * Programs that mean "permanently erase" rather than "delete". They are never
 * rewritten — they are denied outright.
 *
 * Matched in **program position** (the command word of a statement, optionally
 * behind a path or a launcher), never as a substring of the whole line. Whole-
 * line matching was the bug: `Get-Content C:\logs\sdelete.log`,
 * `Select-String -Pattern "wipe" notes.md` and `grep -n "shred" *.md` all name an
 * erase tool while erasing nothing, and all three were refused as if they were
 * about to erase the disk.
 */
const WIPE_PROGRAMS = new Set([
  'sdelete', 'sdelete64', 'shred', 'srm', 'wipe',
  // PowerShell's Storage module erases a whole volume or disk, which is further than
  // any file delete: there is no Recycle Bin for a partition. They are ordinary
  // cmdlets, so a cmdlet name in command position is the evidence — no flag needed.
  // Measured 2026-11-25: all three were allowed while `format D:` was refused, so the
  // CMD spelling was covered and the PowerShell equivalent was not.
  'format-volume', 'clear-disk', 'initialize-disk',
]);

/**
 * Verbs whose following argument is itself the program that will run.
 * `Start-Process -FilePath shred …` and `cmd /c shred …` name the wipe tool as
 * an argument, so looking only at the command word would miss them.
 */
const LAUNCHER_VERBS = new Set(['start-process', 'start', 'saps', 'cmd', 'invoke-item', 'ii']);

/**
 * `Start-Process` switches that take a value.
 *
 * Needed because the program slot is found by position: without knowing which switches
 * consume the token after them, `Start-Process -WindowStyle Hidden shred` reads `Hidden`
 * as the program. Only the ones that carry a value are listed — a switch that takes none
 * leaves the next token to be read normally, which is what makes `Start-Process notepad`
 * work.
 *
 * The list is `Start-Process`'s own, from its parameter set. A switch that appears in a
 * later PowerShell and is missing here degrades to "its value looks like the program
 * slot", which fails towards refusal only when that value happens to name a wipe tool.
 */
const START_PROCESS_VALUE_FLAGS = new Set([
  '-filepath', '-path', '-argumentlist', '-args', '-workingdirectory', '-windowstyle',
  '-verb', '-credential', '-redirectstandardinput', '-redirectstandardoutput',
  '-redirectstandarderror', '-inputobject', '-environment',
]);

/**
 * Every `Start-Process` switch, valued or not.
 *
 * Needed as the **boundary** of an earlier switch's value. A value may begin with a dash —
 * `-ArgumentList "-NoProfile shred -u /tmp/x"` is an ordinary spelling — so "the next token
 * starts with `-`" is not where the value ends. Only a token that actually names a switch
 * is. Reading the boundary the other way collected an empty value, and the whole
 * `Start-Process -FilePath powershell -ArgumentList "-NoProfile shred …"` shape was allowed.
 * Measured 2026-11-25.
 */
const START_PROCESS_SWITCHES = new Set([
  ...START_PROCESS_VALUE_FLAGS,
  '-wait', '-passthru', '-nonewwindow', '-usenewenvironment', '-loaduserprofile',
  '-useNewEnvironment',
]);

/**
 * Erase by flag rather than by program name: `cipher /w E:` overwrites a volume's free
 * space, `format D:` destroys the volume.
 *
 * **Where** these words sit decides whether they are a command. Matching the shape anywhere
 * in the command refused a search pattern — `Select-String -Pattern "format D:" notes.md`,
 * `Get-Content notes.md | Select-String "cipher /w"` — and maintaining this plugin's own
 * README, which names both, was impossible. Measured 2026-11-25.
 *
 * The words are therefore judged as the statement's program (or a launcher's payload), the
 * same position rule `wipeProgramIn` uses for `shred` and `sdelete`, and only their
 * arguments decide whether a volume is at stake.
 */
const VOLUME_WIPE_ARGS = {
  // The argument string starts at the first switch, so `/w` may be the very first token.
  cipher: /(?:^|\s)\/w\b|\/w:/i,
  format: /\b[a-z]:/i,
  // `diskpart clean` removes the selected disk's partition information; `clean all`
  // additionally zeroes every sector; `diskpart /s script.txt` runs a script whose body
  // this guard never sees. Like `format`, the word is ordinary English, so it counts only
  // in program position — see `wipeProgramIn`.
  diskpart: /\bclean\b|\/s\b/i,
};

/**
 * A wipe-program name anywhere inside the body handed to a child *shell*
 * (`bash -c "shred -u x"`). Such a body is shell text, not an operand, so the
 * argument that *calls* itself out of program position does not protect it.
 */
const WIPE_NAME_IN_BODY = /\b(?:sdelete64|sdelete|shred|srm|wipe|format-volume|clear-disk|initialize-disk)\b/i;

/**
 * A call that hands a string to a process, for interpreters whose body is *not*
 * shell text. `node -e "…shred…"` only erases anything if the name reaches an
 * `exec`/`spawn`/`system` call; without one it is a word in a string.
 *
 * Measured 2026-11-15, on the published 2.2.3: maintaining this very repository
 * was refused, because the README text being written quoted `shred` inside a
 * `node -e` body — prose, no process involved. The rule read the name anywhere in
 * the body and could not tell documentation from a command.
 */
const SPAWN_CALL =
  /(?:\.\s*(?:exec|execFile|execSync|spawn|spawnSync|popen)\s*\(|\b(?:exec|execFile|execSync|spawn|spawnSync)\s*\(|\bsubprocess\s*\.\s*(?:run|call|Popen|check_output|check_call)\s*\(|\bos\s*\.\s*(?:system|popen|execl?\w*|spawn\w*)\s*\(|\bsystem\s*\(|%\s*x\s*[({])/i;

/**
 * A destructuring import of a process-spawning API:
 * `const { execSync } = require('child_process')`. Measured 2026-11-24: this shape
 * then calls a bare `execSync(...)`, which {@link SPAWN_CALL} did not catch (every
 * branch required a leading dot), so `execSync('shred -u x')` was allowed.
 *
 * Recognised as the assignment itself rather than by loosening SPAWN_CALL: dropping
 * the dot requirement would also match `db.exec(...)` and `/re/.exec(...)` in any
 * context.
 */
const SPAWN_DESTRUCTURED = /(?:const|let|var)\s*\{[^}]*\b(?:exec|execFile|execSync|spawn|spawnSync|popen)\b[^}]*\}\s*=\s*require\s*\(\s*['"]child_process['"]\s*\)/i;

/**
 * Child interpreters whose inline body is a shell program. For these, any name in
 * the body counts as a program name; for every other interpreter the name must
 * also reach a process-spawning call.
 *
 * Matched in **program position**, never as a bare word: `node -e "…{dialect:'pwsh'}…"`
 * contains the literal `pwsh` and was audited as if it were a shell script, which
 * made the same word in the same body read as a program name.
 */
const SHELL_INTERPRETERS = /^(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?$/i;

/**
 * Shell command lines that run a program named in their **arguments**, as opposed to the
 * ones that only take switches.
 *
 * `powershell -NoProfile shred -u /tmp/x` executes `shred`: the first positional argument
 * is the command. `bash -c "shred …"` executes it through `-c`. Neither is a launcher in
 * `LAUNCHER_VERBS`, so a call whose head is a shell used to be dropped without looking at
 * its arguments at all — four such shapes were still open, measured 2026-11-25, all of
 * them reaching the interpreter through `cmd /c` or `Start-Process`.
 */
const SHELL_CLI = new Set(['powershell', 'pwsh', 'bash', 'sh', 'zsh']);

/**
 * Shell switches whose value is a command line, and the ones whose value is not a program.
 *
 * `-File` names a script, `-ExecutionPolicy` names a policy, `-WindowStyle` a style; none
 * of those is a program to look up. `-EncodedCommand` is skipped here because the base64
 * body is already decoded and judged by `decodedInlineBodies`.
 */
const SHELL_COMMAND_FLAGS = new Set(['-c', '-command', '--eval', '--execute']);
const SHELL_VALUE_FLAGS = new Set([
  '-file', '-f', '-executionpolicy', '-ex', '-ep', '-windowstyle', '-version', '-v',
  '-inputformat', '-outputformat', '-configurationname', '-custompipename',
  '-settingsfile', '-workingdirectory', '-wd', '-o', '-i',
]);

/**
 * `cmd` keywords that prefix a command without being it.
 *
 * `cmd /c if exist C:\x sdelete C:\secret` runs `sdelete` — the program sits behind the
 * conditional, so reading only the first word of the payload sees `if` and stops.
 */
const CMD_COMPOUND = new Set(['if', 'for', 'while', 'until', 'goto', 'call', 'start']);

/**
 * Every shell CLI switch, used as the **boundary** of `-c` / `-Command`'s value.
 *
 * A command line may begin with a switch — `-c "-NoProfile shred …"` — so "the next token
 * starts with a dash" is not where the value ends. Only a token that names a switch is.
 */
const SHELL_SWITCHES = new Set([
  ...SHELL_COMMAND_FLAGS,
  ...SHELL_VALUE_FLAGS,
  '-noprofile', '-noninteractive', '-nologo', '-noexit', '-sta', '-mta', '-login',
  '-sshservermode', '-help', '-?', '-configurationfile',
]);

/**
 * A shell invoked through a variable, decided from the statement's tokens rather
 * than by regex over the whole line.
 *
 * `splitStatements` already treats `&` as a separator, so `… ; & $sh -c "…"` arrives
 * as the statement `$sh -c "…"` — the `&` is gone by the time a per-statement check
 * runs. Looking at the statement's own tokens is what makes the shape visible.
 *
 * Measured 2026-11-24: `$shellPath='…\bash.exe'; & $shellPath -c "…"` was allowed,
 * while `$sh='bash'; & $sh -c "…"` was denied only because the variable name
 * contains `sh` — a denial by coincidence of naming, not by rule.
 *
 * @param statement - one statement, already split.
 * @returns whether the statement runs a variable as a shell with an inline body.
 */
function invokesShellVariable(statement) {
  // Cheap pre-check before tokenizing: the statement has to *start* with a variable
  // and carry an inline-body flag. `tokenize` per statement was measurable on the
  // tool-call path (2026-11-24), and almost no statement looks like this.
  const head = statement.trimStart();
  if (head.charCodeAt(0) !== 36 /* $ */) return false;
  if (!/-(?:c|command)\b/i.test(statement)) return false;

  const tokens = tokenize(statement).filter((t) => t.length > 0);
  const program = tokens[0];
  if (program === undefined) return false;
  // The program position must be a variable.
  if (!/^\$[A-Za-z_][\w:]*$/.test(program)) return false;
  // …and it must be handed an inline-body flag.
  const flagAt = tokens.findIndex((t, i) => i > 0 && /^-(?:c|command)$/i.test(t));
  if (flagAt === -1) return false;
  // Only when the body is worth judging: a delete verb or an erase tool. Otherwise
  // this is `$bash -c "ls -la"`, and refusing it would be a false positive — the
  // direct spelling `bash -c "ls -la"` is allowed on purpose.
  const body = tokens.slice(flagAt + 1).join(' ');
  return SHELL_DELETE_VERB.test(body) || WIPE_NAME_IN_BODY.test(body);
}

/** Any shell name, for the places that genuinely need "does this statement mention one". */
const SHELL_NAME_ANYWHERE = /\b(?:bash|sh|zsh|pwsh|powershell)\b/i;

/** Denial text shared by every permanent-erase rule. */
const WIPE_REASON =
  'Permanent-erase tools (shred/sdelete/srm/cipher /w/format) are disabled by the recycle-bin guard. ' +
  'Use the file_trash tool so the data stays recoverable.';

/**
 * Command fragments that empty or bypass the Recycle Bin. Denied, because the
 * whole point of this plugin is that deleted data stays recoverable.
 */
const EMPTY_RECYCLE_RULES = [
  // `Clear-RecycleBin` is an action only in command position. Matching it
  // anywhere refused `Select-String -Pattern "Clear-RecycleBin" README.md`,
  // i.e. reading this plugin's own documentation about the rule. Command
  // position is resolved per statement by `commandWordsOf` below, which also
  // reaches the invoke-operator and child-shell spellings.
  // Reaching *into* the bin store is only meaningful behind a delete verb, so
  // these stay verb-anchored and are judged per statement.
  { re: /\bremove-item\b[^\n;&|]*(?:\$recycle\.bin|recycler\b)/i, what: 'a delete inside the Recycle Bin' },
  { re: /\brd\b[^\n;&|]*(?:\$recycle\.bin|recycler\b)/i, what: 'a delete inside the Recycle Bin' },
  { re: /\brmdir\b[^\n;&|]*(?:\$recycle\.bin|recycler\b)/i, what: 'a delete inside the Recycle Bin' },
  { re: /\bdel\b[^\n;&|]*(?:\$recycle\.bin|recycler\b)/i, what: 'a delete inside the Recycle Bin' },
  { re: /\brm\b[^\n;&|]*(?:\$recycle\.bin|recycler\b)/i, what: 'a delete inside the Recycle Bin' },
];

/**
 * The arguments of a `git` statement, or `undefined` when it names no git subcommand.
 *
 * `git clean` deletes untracked files outright: not through the Recycle Bin, and not
 * recoverable — git never had their content. Three neighbours destroy working-tree
 * content the same way and name no delete verb either: `git reset --hard`,
 * `git checkout -- <path>` and `git restore <path>` replace files with the index copy,
 * throwing away uncommitted edits that exist nowhere else, and `git rm` removes the file
 * as well as the index entry. All of them are exactly what this plugin exists to keep
 * out of reach, so they are asked about directly rather than through the delete parser.
 *
 * What stays allowed: `git clean -n` / `--dry-run` (lists the same entries, removes
 * nothing), `git checkout <branch>` without a pathspec, `git restore --staged` (unstages
 * only) and `git rm --cached` (index only).
 */
const GIT_ARGS = /\bgit\b([^\n;&|]*)/i;

/**
 * What a `git` statement destroys in the working tree, if anything.
 *
 * @param statement - one statement.
 * @returns `{ kind, what, recipe }` when it destroys content, else `undefined`.
 */
function gitDestroysWorktree(statement) {
  const match = GIT_ARGS.exec(statement);
  if (match === null) return undefined;
  const args = match[1];

  const clean = /\bclean\b([^\n;&|]*)/i.exec(args);
  if (clean !== null) {
    const rest = clean[1];
    // A letter inside a bundled short flag counts wherever it sits: `-fd`, `-df`, `-nfd`.
    const dry = /(?:^|\s)-(?:[a-z]*n[a-z]*|n)\b|--dry-run\b/i.test(rest);
    const force = /(?:^|\s)-(?:[a-z]*f[a-z]*|f)\b|--force\b/i.test(rest);
    if (!force || dry) return undefined;
    return {
      kind: 'delete',
      what: '`git clean` deletes untracked files permanently — they were never committed, so there is nothing '
        + 'to restore them from and they do not go through the Recycle Bin',
      recipe: 'Run `git clean -n` first to see the list; if you really mean to remove those files, do it yourself '
        + 'or hand their paths to file_trash.',
    };
  }

  const rm = /\brm\b([^\n;&|]*)/i.exec(args);
  if (rm !== null) {
    if (/--cached\b/i.test(rm[1])) return undefined;
    return {
      kind: 'delete',
      what: '`git rm` deletes the file from the working tree as well as from the index, and the deletion does not '
        + 'go through the Recycle Bin',
      recipe: 'Delete the paths with file_trash, then stage the removals with `git add -A`.',
    };
  }

  if (/\breset\b[^\n;&|]*--hard\b/i.test(args)) {
    return {
      kind: 'git-discard',
      what: '`git reset --hard` replaces every tracked file with the committed copy, so uncommitted edits are gone '
        + 'and nothing enters the Recycle Bin',
      recipe: 'Keep the changes first — `git stash push`, or `git diff > changes.patch` — then run it.',
    };
  }

  const checkout = /\bcheckout\b([^\n;&|]*)/i.exec(args);
  if (checkout !== null && (/\s--(?:\s|$)/.test(checkout[1]) || /^\s+\.(?:\s|$)/.test(checkout[1]))) {
    return {
      kind: 'git-discard',
      what: '`git checkout -- <path>` replaces the working-tree file with the index copy, so uncommitted edits to it '
        + 'are gone and nothing enters the Recycle Bin',
      recipe: 'Keep the changes first — `git diff -- <path> > changes.patch`, or `git stash push -- <path>` — then run it.',
    };
  }

  const restore = /\brestore\b([^\n;&|]*)/i.exec(args);
  if (restore !== null && (!/--staged\b/i.test(restore[1]) || /--worktree\b/i.test(restore[1]))) {
    return {
      kind: 'git-discard',
      what: '`git restore` replaces the working-tree file with the index copy, so uncommitted edits to it are gone '
        + 'and nothing enters the Recycle Bin',
      recipe: 'Keep the changes first — `git diff -- <path> > changes.patch` — then run it.',
    };
  }

  return undefined;
}

/**
 * The Recycle Bin's own emptying paths, which never name a delete verb.
 *
 * Four shapes reach the bin's contents: the cmdlet in command position
 * (`Clear-RecycleBin -Force`), the invoke operator with the name as a string
 * (`& "Clear-RecycleBin"`), a child shell running it
 * (`pwsh -Command "Clear-RecycleBin"`, `-EncodedCommand <base64>`), and the
 * Win32 call `SHEmptyRecycleBin`. A fifth drives the bin's *own* shell verbs
 * over its items (`InvokeVerb('delete')` / `Verbs()` + `DoIt()`), which is what
 * Explorer's "delete" does to a bin item: permanent, no recycle.
 *
 * All five were allowed by 1.0.6 and are holes worth closing: `pwsh -Command
 * "Clear-RecycleBin -Force"` empties the bin silently, one shell call away.
 */
const EMPTY_BIN_COMMAND = /^clear-recyclebin$/i;
const EMPTY_BIN_API = /\bSHEmptyRecycleBin\w*\b/i;
/**
 * Reaching the bin *as an object*. The items it yields flow down a pipe, which is why
 * this reference is allowed to travel across statements — see the loop in
 * `classifyCommand`.
 */
const BIN_OBJECT_REF = /Namespace\(\s*(?:10|0xa)\s*\)|shell:RecycleBinFolder/i;
/**
 * Naming the bin by path. Only meaningful in the statement that uses it: `$Recycle.Bin`
 * is also just text, and appears in `Select-String -Pattern`, `Get-Content` arguments
 * and notes. Treating it as a bin reference anywhere in the command made a search for
 * that string convict an unrelated `InvokeVerb` — measured 2026-11-25.
 */
const BIN_PATH_REF = /\$recycle\.bin/i;

/**
 * Driving the bin's own verbs — the part that actually destroys.
 *
 * `.Verbs()` was listed here until 2026-11-24, which made **enumerating** a verb
 * list look like **executing** one. Measured: the sanctioned recovery path
 * (`$item.Verbs() | Where-Object { $_.Name -like '*还原*' }`) was refused, and so was
 * a read-only listing of what verbs a bin item offers — while the README promises
 * restoring is allowed.
 *
 * `DoIt()` stays in the driving set and is never exempted: it runs whichever verb is
 * currently selected, and which one that is cannot be read off the command. Measured
 * 2026-11-24: a "restore word anywhere in the line" exemption was fooled by a bare
 * comment — `… | % { $_.DoIt() }  # restore is a different verb` became allowed.
 */
const BIN_VERB_ENUM = /\.Verbs\s*\(\s*\)/i;
const BIN_VERB_DRIVE = /\bInvokeVerb\s*\(|\.DoIt\s*\(/i;
/**
 * `InvokeVerb('…')` whose argument names a restore rather than a destroy.
 *
 * `undelete` is in the list because it is what a large share of the restore scripts
 * found in the wild pass, and it is the verb some shell versions expose. It used to be
 * refused: it is not `estore`, so it fell through to the "invoking a verb on the bin"
 * branch, and being refused as a *delete* is the wrong answer for a restore — measured
 * 2026-11-25, together with `InvokeVerb('Restore')` and `InvokeVerb('还原')` both
 * passing. Nothing is hidden by accepting it: a restore puts a file back.
 */
const BIN_VERB_RESTORE_ARG = /InvokeVerb\s*\(\s*['"][^'"]*(?:estore|undelete|还原|复原)[^'"]*['"]/i;
/** `InvokeVerb('…')` whose argument names a destroy. */
const BIN_VERB_DELETE_ARG = /InvokeVerb\s*\(\s*['"][^'"]*(?:delete|remove|删除|清除)[^'"]*['"]/i;

/**
 * Cheap pre-check: could this statement reach the bin's verbs at all? Neither
 * `.DoIt(`/`InvokeVerb(` nor a bin reference appears in ordinary commands, so this
 * one test keeps four regexes and two `Namespace(10)` probes off the common path.
 */
const BIN_TOUCH = /\bInvokeVerb\s*\(|\.DoIt\s*\(|Namespace\s*\(\s*(?:10|0xa)\s*\)|shell:RecycleBinFolder|\$recycle\.bin/i;

/**
 * Constructs that can hide a delete from a text-level parser, or make the
 * rewrite target set unknowable. A command containing any of these is denied
 * rather than rewritten: silently moving the wrong path is worse than refusing.
 *
 * Entries may carry `dialects` to restrict them to one shell language. The
 * distinction matters for `$( … )`: PowerShell treats it as command
 * substitution (opaque), while in bash it is ordinary everyday syntax
 * (`$(pwd)`, `$(date)`). Applying the PowerShell rule to bash would refuse
 * almost every real command, so it is dialect-scoped.
 */
const OPAQUE_CONSTRUCTS = [
  { re: /\$\(/, what: 'command substitution $( … )', dialects: ['pwsh'] },
  // Bash only. A backtick pair is command substitution in bash and an **escape character**
  // in PowerShell, where the substitution syntax is `$( … )`: `"backup`1.txt"` is
  // `backup1.txt`, and a backtick before a quote escapes the quote. Calling that a command
  // substitution named the wrong mechanism for pwsh and pointed the caller at the wrong
  // fix. Measured 2026-11-25. The pwsh side is still refused, but by the target check, with
  // a reason that says what a backtick actually does.
  { re: /`[^`]*`/, what: 'backtick command substitution', dialects: ['bash'] },
  { re: /(?<![<>=!])<<</, what: 'here-string / here-doc', dialects: ['pwsh', 'bash'] },
  { re: /\|\s*(?:Remove-Item|del|rm|ri)\b/i, what: 'piped delete', dialects: ['pwsh', 'bash'] },
  // `… | xargs rm` runs a delete whose targets arrive from stdin, so the target
  // set is unknowable. `xargs` hides the verb from the statement parser.
  { re: /\bxargs\b[^\n;&|]*\b(?:rm|rmdir|unlink|del|erase|rd)\b/i, what: 'xargs-driven delete', dialects: ['pwsh', 'bash'] },
  { re: /(?:Remove-Item|del|rm|ri)\b[^\n;&|]*-Recurse\b[^\n;&|]*\*/, what: 'recursive wildcard delete', dialects: ['pwsh', 'bash'] },
  { re: /(?:Remove-Item|rm)\b[^\n;&|]*--?no-preserve-root/, what: 'no-preserve-root', dialects: ['pwsh', 'bash'] },
];

/**
 * Deletes that never appear as a shell delete verb, so the statement parser
 * cannot see them at all. Each entry names what it does in `what`; a match is
 * denied outright, because there is no operand list to hand to `file_trash`.
 *
 * Scope is deliberately narrow. These are *specific* erasing constructs, not
 * the word "delete" anywhere in a line — the previous revision matched
 * `shellDeleteVerb` over the whole command, which refused read-only audits for
 * containing the Python statement `del L[a:b+1]` or the flag `Get-ChildItem -File`.
 *
 * `-delete` is listed for `find` only: in bash, `rm --delete` is not a thing,
 * while `find … -delete` is the ordinary way to erase a tree without `rm`.
 */
const ERASE_CONSTRUCTS = [
  // .NET calls that unlink directly, bypassing the verb table. The pattern keys
  // on the *call*, not on the type reference: `[System.IO.File]::ReadAllBytes`,
  // `::Exists`, `::Copy` and `::Move` name the same type and erase nothing, so
  // matching the literal `[System.IO.File]` refused ordinary read-only audits —
  // e.g. reading a .bat file to check its byte count and line endings.
  { re: /::\s*(?:Delete|DeleteFile|DeleteDirectory)\s*\(/i, what: 'a .NET File/Directory::Delete() call', dialects: ['pwsh'] },
  // The instance-method spelling: `[System.IO.FileInfo]::new($p).Delete()` and
  // the recursive overload `[System.IO.DirectoryInfo]::new($d).Delete($true)`.
  // The no-argument form was a hole until 1.0.4 — only `.Delete($true)` matched,
  // so `(Get-Item $p).Delete()` erased a file unguarded.
  { re: /\.\s*Delete\s*\(\s*(?:\)|\$?(?:true|1)\s*[,)])/i, what: 'a .NET instance Delete() call', dialects: ['pwsh'] },
  // Invoke-Expression / iex evaluates a string: the verb is inside the string, so
  // no statement-level verb is ever seen. Judged by the **body**, not the word —
  // matching the bare name refused `Invoke-Expression "Write-Output 'hello'"`
  // (measured 2026-11-24). When the body is a literal, its text is right there;
  // when it is a variable or a file, it cannot be read and the command is refused
  // by the `iex` handling in classifyCommand below.
  { re: /\b(?:Invoke-Expression|iex)\b[^\n]*\b(?:Remove-Item|ri|del|erase|rd|rmdir|rm|unlink)\b/i, what: 'an Invoke-Expression body containing a delete', dialects: ['pwsh'] },
  // A delete delegated to cmd.exe. The switch is looked for **anywhere** in the
  // argument list, not immediately after `cmd`: `cmd /d /c del` is the same call as
  // `cmd /c del`, and anchoring on the position meant one harmless switch
  // (`/d` disables AutoRun) was enough to slip past — measured 2026-11-25.
  { re: /\bcmd(?:\.exe)?\b[^\n]*\/[ck]\b[^\n]*\b(?:del|erase|rd|rmdir)\b/i, what: 'a delete delegated to cmd.exe', dialects: ['pwsh', 'bash'] },
  // `robocopy … /MIR` mirrors an empty source over the target, which empties it
  // without ever naming a delete verb. /PURGE is the same trick with pruning.
  { re: /\brobocopy\b[^\n]*\/(?:MIR|PURGE)\b/i, what: 'robocopy /MIR or /PURGE (empties the target)', dialects: ['pwsh', 'bash'] },
  // `find … -delete` unlinks without `rm`.
  { re: /\bfind\b[^\n]*(?:^|\s)-delete\b/i, what: 'find -delete', dialects: ['bash'] },
];

/**
 * Interpreter invocations whose *body* is opaque to this parser. The check is
 * two-part on purpose: the interpreter must be invoked with an inline-body flag,
 * and the body must contain an erasing construct. `python -c "print(1+1)"` and
 * `bash -c "ls -la"` must keep working.
 *
 * The erasing API is matched by member name, not by module prefix:
 * `require('fs').rmSync(...)` never contains the text `fs.rmSync`, so a
 * module-qualified pattern missed it. Each name below is a delete in the
 * language it belongs to — `remove`, `unlink`, `rmdir`, `rmtree` — and none of
 * them is a common non-deleting call.
 */
const INLINE_BODY_FLAGS = /(?:^|[\s'"])(?:-c|-e|-Command|-EncodedCommand|--eval|--execute)(?=[\s'"]|$)/i;
const INTERPRETER = /\b(?:bash|sh|zsh|pwsh|powershell|node|python|python3|perl|ruby)\b/i;

/**
 * Rewrite PowerShell's array-as-arguments spelling into a plain argument list.
 *
 * `Start-Process powershell -ArgumentList '-c','Remove-Item C:\x\a.txt'` passes the
 * same body as `Start-Process powershell -ArgumentList '-c Remove-Item C:\x\a.txt'`,
 * but the comma keeps the flag and its payload inside one quoted blob, so the inline
 * body is never seen and the statement is allowed. Measured 2026-11-25: that form ran
 * a delete while the space-separated spelling was refused.
 *
 * Only used for reading the text. The caller's command is never rewritten — this guard
 * denies and redirects, it does not edit what runs.
 *
 * @param statement - one statement.
 * @returns the same statement with `','` / `","` separators turned into spaces.
 */
function normalizeArgumentList(statement) {
  return statement.replace(/(['"])\s*,\s*/g, '$1 ');
}

/**
 * Step over the `cmd` keywords that prefix a command.
 *
 * `cmd /c if exist C:\x sdelete C:\secret` runs `sdelete`: the conditional comes first and
 * the program behind it. Reading only the first word of the payload sees `if` and stops.
 * `for … do <cmd>` and `start "title" <program>` have the same shape — a keyword, its own
 * arguments, then the command.
 *
 * Only the prefix is removed; the command itself is returned unchanged for the caller to
 * read as a statement. `cmd /c if exist C:\x echo sdelete` therefore reduces to
 * `echo sdelete`, whose head is `echo` — a word, not a program.
 *
 * @param tokens - the payload after `/c` or `/k`.
 * @returns the tokens from the command onwards.
 */
function stripCmdCompound(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const word = tokens[i].toLowerCase();
    if (!CMD_COMPOUND.has(word)) break;
    if (word === 'if') {
      i += 1;
      if (tokens[i]?.toLowerCase() === 'not') i += 1;
      const kind = tokens[i]?.toLowerCase();
      // `if exist <path>` / `if defined <var>` / `if errorlevel <n>` each take one value.
      if (kind === 'exist' || kind === 'defined' || kind === 'errorlevel' || kind === 'cmdextversion') {
        i += 2;
        continue;
      }
      // `if <a>==<b>`: the comparison is one token.
      i += 1;
      continue;
    }
    if (word === 'for') {
      // `for %v in (set) do <cmd>`: everything up to and including `do` is the header.
      const doAt = tokens.findIndex((t, at) => at > i && t.toLowerCase() === 'do');
      i = doAt >= 0 ? doAt + 1 : tokens.length;
      continue;
    }
    if (word === 'start') {
      // `start ["title"] [/switches] <program>`
      i += 1;
      while (i < tokens.length && (tokens[i].startsWith('/') || tokens[i].startsWith('"'))) i += 1;
      continue;
    }
    // `goto` / `call` / `while` / `until`: the keyword itself carries nothing to skip.
    i += 1;
  }
  return tokens.slice(i);
}
const PROGRAMMATIC_ERASE =
  /(?:\.\s*(?:rmSync|rmdirSync|unlinkSync|removeSync|rmdir|unlink|rmtree|remove_tree|remove_entry)\s*\(|\.\s*rm\s*\(|\b(?:shutil\s*\.\s*rmtree|os\s*\.\s*(?:remove|unlink|rmdir))\b)/i;

/**
 * Script-file writes that *create* a file containing delete text. Writing a
 * helper script and then running it by path is the documented escape hatch in
 * this plugin's own README; the guard cannot read the body back, but it can
 * refuse to let the write happen.
 *
 * Both spellings are covered because both are ordinary: a redirection
 * (`> clean.ps1`) and a write cmdlet (`| Out-File clean.ps1`). Without the
 * second, the redirect rule is a formality.
 */
const SCRIPT_WRITE_REDIRECT = />>?\s*\S+\.(?:ps1|sh|bash|zsh|bat|cmd|py|js|mjs|ts)\b/i;
const SCRIPT_WRITE_CMDLET =
  /\b(?:Out-File|Set-Content|Add-Content|Tee-Object)\b[^\n;&|]*\.(?:ps1|sh|bash|zsh|bat|cmd|py|js|mjs|ts)\b/i;

/**
 * Shell-level delete verbs, used only by the script-file rule, where the body
 * is not parsed at all.
 */
const SHELL_DELETE_VERB = /\b(?:Remove-Item|ri|del|erase|rd|rmdir|rm|unlink)\b/i;


/**
 * Substitutions that may appear inside a delete operand. The value is only
 * known when the shell expands it, so no path can be proven safe to recycle:
 * the operand must be refused rather than treated as a literal path.
 *
 * This is dialect-independent. bash permits `$( … )` as ordinary syntax, but
 * never as an unexpandable delete target.
 */
const SUBSTITUTION_IN_TARGET = /\$\(|`|\$\{|\$[A-Za-z_]/;

/**
 * PowerShell providers that hold **no files**, so a delete through them destroys
 * something the Recycle Bin could never have held. Allowed: refusing these gave the
 * model an instruction that cannot work (`file_trash "variable:x"`).
 *
 * `Remove-Variable` / `clear-variable` were already allowed, so refusing
 * `Remove-Item variable:x` was inconsistent as well as useless.
 */
const NON_FILE_PROVIDERS = new Set(['variable', 'env', 'function', 'alias', 'psdrive']);

/**
 * Providers that hold durable state outside the file system. Denied, but with a
 * reason that does **not** name `file_trash` — routing a registry key or a
 * certificate to the Recycle Bin is not a thing that can happen.
 */
const OTHER_PROVIDERS = new Set(['hkcu', 'hklm', 'cert', 'wsman', 'registry']);

/** Path shapes that must never be rewritten into a recycle-bin move. */
const FORBIDDEN_TARGETS = [  { re: /^[a-z]:[\\/]?$/i, what: 'a drive root' },
  { re: /^[\\/]$/, what: 'the filesystem root' },
  { re: /^(?:\$env:SystemRoot|%SystemRoot%|[a-z]:\\Windows)(?:[\\/]|$)/i, what: 'the Windows directory' },
  { re: /^(?:\$env:ProgramFiles|%ProgramFiles%|[a-z]:\\Program Files)/i, what: 'Program Files' },
  { re: /(?:^|[\\/])\.\.(?:[\\/]|$)/, what: 'a parent-directory traversal' },
  { re: /^\$recycle\.bin$/i, what: 'the Recycle Bin itself' },
];

/**
 * Reduce a token to the name of the program it would execute: unquoted, with
 * the directory dropped, lower-cased, and with a launcher extension removed.
 *
 * `"C:\tools\sdelete64.exe"` → `sdelete64`. This is what makes "is this token a
 * wipe tool" answerable without also matching a *file named* `sdelete.log`.
 *
 * @param token - one argv token.
 * @returns the program name, or `''` for an empty token.
 */
function programName(token) {
  const bare = unquote(token).trim();
  if (bare.length === 0) return '';
  const base = bare.split(/[\\/]/).pop() ?? '';
  // A backtick is PowerShell's escape character, and it may sit anywhere in a command
  // name: `R`emove-I`tem`, `s`delete`, `Clear-Recy`cleBin` all run the named program.
  // Dropping them here makes the program-position tables answer for the program that
  // actually runs. In bash a backtick pair is substitution rather than an escape, but
  // reading both spellings as the same program only ever refuses more — and a command
  // whose name is assembled at run time is refused elsewhere.
  return base.replace(/`/g, '').toLowerCase().replace(/\.(?:exe|com|bat|cmd|ps1|sh)$/, '');
}

/**
 * Find a wipe program that a single statement actually runs.
 *
 * Only two positions count: the command word, and the argument of a launcher
 * (`Start-Process -FilePath shred`, `cmd /c shred`). Everything else in a
 * statement is an operand, and an operand is allowed to be a file whose name
 * contains the word.
 *
 * @param statement - one statement, already split from the command.
 * @returns the wipe program name, or `undefined` when the statement runs none.
 */
/**
 * Returned by `wipeProgramIn` when the launcher nesting ran out of the depth it reads.
 *
 * Distinct from `undefined`, which means "this statement runs no wipe program". The
 * difference matters: a command that is too deeply nested to read is not a command that
 * was cleared. Measured 2026-11-25 — `cmd /c cmd /c cmd /c cmd /c cmd /c sdelete C:\x`
 * really executes, and the depth limit was answering "not a wipe" instead of "I cannot
 * tell". A guard that cannot read a command must refuse it.
 */
const UNREADABLE = Symbol('launcher nesting too deep to read');

/**
 * Find a wipe program that a single statement actually runs.
 *
 * Only program positions count: the command word, and the position each kind of launcher
 * or shell runs from. Everything else is an operand, and an operand is allowed to be a
 * file whose name contains the word.
 *
 * The shape of that answer differs per launcher, which is why this resolves position
 * rather than scanning the argv:
 *
 *   cmd /c|/k …            the first command after the switch, behind `if`/`for` prefixes
 *   Start-Process / start  `-FilePath`, else the first positional; its `-ArgumentList`
 *                          only matters when that program is itself a shell
 *   Invoke-Item / ii       the first positional
 *   powershell / bash …    the `-c` / `-Command` value, else the first positional, which
 *                          the shell runs as a command
 *
 * Recursion is what makes `cmd /c powershell -c sdelete …` fail closed: the outer shell's
 * payload is another shell command line, and it is read as one.
 *
 * @param statement - one statement, already split from the command.
 * @param depth - recursion guard.
 * @returns the wipe program name, `UNREADABLE` when the nesting ran out, or `undefined`
 *   when the statement runs none.
 */
function wipeProgramIn(statement, depth = 0) {
  if (depth > 4) return UNREADABLE;
  const tokens = tokenize(normalizeArgumentList(statement)).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;

  const head = programName(tokens[0]);
  if (WIPE_PROGRAMS.has(head)) return head;

  // A volume erased by flag rather than by program name. Same position rule: these words
  // are ordinary enough to appear in prose and in search patterns, so only the program slot
  // plus the argument that names a volume makes them a wipe.
  const volumeArgs = VOLUME_WIPE_ARGS[head];
  if (volumeArgs !== undefined && volumeArgs.test(tokens.slice(1).join(' '))) return head;

  // A shell command line: what it runs is named in its arguments.
  if (SHELL_CLI.has(head)) {
    for (let i = 1; i < tokens.length; i += 1) {
      const lower = tokens[i].toLowerCase();
      if (SHELL_COMMAND_FLAGS.has(lower)) {
        // The value runs to the next *switch*, not to the next dash: a command line may
        // begin with one (`-NoProfile shred …`). It is itself a command line, so it is
        // split before being read — `-c "cd /tmp && shred -u x"` is two statements.
        let end = i + 1;
        while (end < tokens.length && !SHELL_SWITCHES.has(tokens[end].toLowerCase())) end += 1;
        const body = tokens.slice(i + 1, end).join(' ');
        for (const inner of splitStatements(body)) {
          const nestedInBody = wipeProgramIn(inner, depth + 1);
          if (nestedInBody !== undefined) return nestedInBody;
        }
        i = end - 1;
        continue;
      }
      if (SHELL_VALUE_FLAGS.has(lower)) {
        i += 1; // its value is a script, a policy, a style — never a program name
        continue;
      }
      // Any other switch takes no value (`-NoProfile`, `-NonInteractive`).
      if (lower.startsWith('-')) continue;
      // The first positional argument is what the shell runs.
      return wipeProgramIn(tokens.slice(i).join(' '), depth + 1);
    }
    return undefined;
  }

  if (!LAUNCHER_VERBS.has(head)) return undefined;

  if (head === 'cmd') {
    for (let i = 1; i < tokens.length - 1; i += 1) {
      if (!/^\/[ck]$/i.test(tokens[i])) continue;
      // Everything after the switch is the payload; `if`/`for` prefixes are stepped over
      // so the program behind them is the one read.
      return wipeProgramIn(stripCmdCompound(tokens.slice(i + 1)).join(' '), depth + 1);
    }
    return undefined;
  }

  // Start-Process family and Invoke-Item: find the program slot.
  //
  // Switch order does not matter to PowerShell, and it must not matter here either. An
  // earlier version stopped scanning at `-ArgumentList`, so
  //
  //   Start-Process -ArgumentList "-u /tmp/x" -FilePath shred
  //
  // never reached the `-FilePath` and was allowed, while the same call with the switches
  // reversed was refused. Six shapes were open this way, measured 2026-11-25. So the
  // whole argv is scanned and the two switches are collected wherever they appear.
  let program;
  let argumentList;
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    if (lower === '-filepath' || lower === '-path') {
      program = tokens[i + 1];
      i += 1;
      continue;
    }
    if (lower === '-argumentlist' || lower === '-args') {
      // The value runs to the next *switch*, not to the next dash — `-ArgumentList
      // "-NoProfile shred -u /tmp/x"` is an ordinary spelling and starts with one.
      let end = i + 1;
      while (end < tokens.length && !START_PROCESS_SWITCHES.has(tokens[end].toLowerCase())) end += 1;
      argumentList = tokens.slice(i + 1, end).join(' ');
      i = end - 1;
      continue;
    }
    // A valued switch of the launcher's own: skip its value so it is not mistaken for
    // the program slot. `Start-Process -WindowStyle Hidden shred` puts `Hidden` here.
    if (START_PROCESS_VALUE_FLAGS.has(lower)) {
      i += 1;
      continue;
    }
    if (program === undefined && !token.startsWith('-')) program = token;
  }

  if (program === undefined) return undefined;
  const name = programName(program);
  if (WIPE_PROGRAMS.has(name)) return name;
  // A shell launched as the program runs what it is handed; anything else treats its
  // arguments as data.
  if (argumentList === undefined) return undefined;
  if (!LAUNCHER_VERBS.has(name) && !SHELL_INTERPRETERS.test(name)) return undefined;
  return wipeProgramIn(`${program} ${argumentList}`, depth + 1);
}

/**
 * The body text of a statement that hands a program to a child shell:
 * `pwsh -Command "…"`, `bash -c "…"`, `node -e "…"`.
 *
 * @param statement - one statement.
 * @returns the body text, or `undefined` when the statement runs no child.
 */
function inlineBodyText(statement) {
  const tokens = tokenize(normalizeArgumentList(statement)).filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (!/^-(?:c|e|command|eval|execute)$/i.test(tokens[i])) continue;
    return tokens.slice(i + 1).join(' ');
  }
  return undefined;
}

/**
 * Every command word a statement can run: its own, plus the ones inside a body
 * handed to a child shell.
 *
 * @param statement - one statement.
 * @returns the command words found.
 */
function commandWordsOf(statement) {
  const words = [commandWord(statement), ...launcherPayloadWords(statement)];
  const body = inlineBodyText(statement);
  if (body !== undefined) {
    for (const inner of splitStatements(body)) words.push(commandWord(inner));
  }
  // A backtick inside a PowerShell command name is an escape, not part of the name
  // (`Clear-Recy`cleBin`). Dropping it here keeps the bin-emptying check answering for
  // the cmdlet that actually runs.
  return words.filter((w) => w.length > 0).map((w) => w.replace(/`/g, ''));
}

/**
 * Command words hidden in a launcher's arguments: `Start-Process pwsh
 * -ArgumentList "-c","Clear-RecycleBin -Force"`, `cmd /c rd …`.
 *
 * The program is an operand there, so `commandWord` never sees it. Each argument
 * token is split on commas (PowerShell array syntax) and re-read as a statement.
 *
 * @param statement - one statement.
 * @returns the command words found in launcher arguments.
 */
function launcherPayloadWords(statement) {
  if (!LAUNCHER_VERBS.has(commandWord(statement).toLowerCase())) return [];
  const out = [];
  for (const token of tokenize(statement).slice(1)) {
    for (const piece of token.split(/[,;]/)) {
      const inner = piece.trim();
      if (inner.length === 0) continue;
      for (const nested of splitStatements(inner)) out.push(commandWord(nested));
    }
  }
  return out;
}

/**
 * Decode `-EncodedCommand` bodies (base64 of UTF-16LE) into statements.
 *
 * The flag exists to hand PowerShell a program without it appearing on the
 * command line, so treating it as opaque would let it carry any delete past
 * every text rule. Decoding costs nothing and makes the body visible to the same
 * per-statement checks as everything else.
 *
 * PowerShell accepts any unambiguous **prefix** of a parameter name, so `-enc`,
 * `-Encoded` and `-e` all hand over the same body. Matching only the full spelling
 * meant a one-character edit turned a decoded delete into an invisible one — measured
 * 2026-11-25, `pwsh -enc <base64 Clear-RecycleBin -Force>` was allowed while
 * `-EncodedCommand` was refused. Every prefix is accepted here; refusing a body that
 * decodes to nothing costs nothing, and a decodable body is judged like any other
 * statement.
 *
 * @param command - the full command text.
 * @returns the statements decoded from every encoded body.
 */
function decodedInlineBodies(command) {
  const out = [];
  for (const m of command.matchAll(/-(?:e|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)\b\s+([A-Za-z0-9+/=]{8,})/gi)) {
    try {
      const text = Buffer.from(m[1], 'base64').toString('utf16le');
      if (text.trim().length > 0) out.push(...splitStatements(text));
    } catch {
      // Not decodable as base64/UTF-16LE: nothing to add.
    }
  }
  return out;
}

/**
 * Every `[scriptblock]::Create(<quoted literal>)`, capturing the body.
 *
 * Deliberately anchored on the closing quote rather than on the first `)`: a body is
 * ordinary script text and may contain parentheses (`"if (Test-Path C:\x) { 'ok' }"`).
 * Stopping at the first `)` truncated the body, so a readable literal looked like an
 * unreadable expression and `[scriptblock]::Create("Write-Output (1+1)")` was refused
 * with a reason claiming the text was only knowable at run time. Measured 2026-11-25.
 *
 * Shared by both readers so they cannot disagree about what a literal is.
 */
const LITERAL_SCRIPTBLOCK = /\[scriptblock\]\s*::\s*Create\s*\(\s*(['"])((?:(?!\1)[\s\S])*)\1\s*\)/gi;

/**
 * Read `[scriptblock]::Create(<literal>)` bodies into statements.
 *
 * This is the same construct as `Invoke-Expression`: PowerShell parses the string and
 * runs it. `Invoke-Expression` is refused by `ERASE_CONSTRUCTS`, so a delete written
 * through `[scriptblock]::Create` was passing by a rule the plugin already applies to
 * its twin — measured 2026-11-25: `& ([scriptblock]::Create("Remove-Item C:\x\a.txt"))`
 * was allowed while `Invoke-Expression "Remove-Item C:\x\a.txt"` was refused.
 *
 * A literal body is decoded and judged like any other statement, so a harmless script
 * block still passes. A body that is not a literal cannot be read, and is reported
 * separately by `opaqueScriptBlock` rather than guessed at.
 *
 * @param command - the full command text.
 * @returns the statements decoded from every literal script block.
 */
function decodedScriptBlockBodies(command) {
  const out = [];
  for (const m of command.matchAll(LITERAL_SCRIPTBLOCK)) {
    const text = m[2];
    if (text.trim().length > 0) out.push(...splitStatements(text));
  }
  return out;
}

/**
 * Whether a script block is built from something other than a literal.
 *
 * Decided by subtraction: strip every call that has a quoted literal body, and see
 * whether any `Create(` is left. Whatever remains is built from a variable, a file
 * read, or some other expression whose text cannot be read here.
 *
 * @param command - the full command text.
 * @returns true when a `[scriptblock]::Create` call has no readable literal body.
 */
function opaqueScriptBlock(command) {
  if (!/\[scriptblock\]\s*::\s*Create\s*\(/i.test(command)) return false;
  const withoutLiterals = command.replace(LITERAL_SCRIPTBLOCK, '');
  return /\[scriptblock\]\s*::\s*Create\s*\(/i.test(withoutLiterals);
}

/**
 * Name the shape that made an operand untranslatable, instead of calling every one of
 * them a command substitution.
 *
 * One regex covers four different things: `$name`, `${name}`, `$( … )` and `` `…` ``.
 * The refusal used to say "command substitution" for all of them, so a caller who
 * wrote `Remove-Item $var` was told to resolve a subexpression it had not written and
 * had no reason to resolve. Measured 2026-11-25; the earlier false-positive sweep
 * recorded the same mismatch.
 *
 * @param operand - the operand that matched `SUBSTITUTION_IN_TARGET`.
 * @returns a phrase naming the actual form.
 */
function describeUntranslatable(operand) {
  if (operand.includes('$(')) return 'a command substitution `$( … )`';
  if (operand.includes('`')) return 'a backtick command substitution';
  // No closing-brace requirement: the tokenizer can leave `${NAME` without its `}`
  // when the operand is a fragment, and `SUBSTITUTION_IN_TARGET` matches either way.
  if (/\$\{/.test(operand)) return 'a braced variable `${ … }`';
  if (/\$[A-Za-z_]/.test(operand)) return 'a variable `$name`';
  return 'a value only known at run time';
}

/**
 * Whether `Invoke-Expression` / `iex` is handed something other than a literal.
 *
 * A quoted literal body is read by `ERASE_CONSTRUCTS`, which refuses it when it names
 * a delete and allows it otherwise. A variable, a file read or any other expression is
 * not readable here, so the same rule as a script block applies: refuse. Before this,
 * `Invoke-Expression $var` was allowed while the comment on the `iex` rule said it was
 * refused — the code and its own description disagreed, and the permissive side won.
 *
 * @param statement - one statement.
 * @returns true when an `iex` call has no readable literal body.
 */
function opaqueInvokeExpression(statement) {
  // The lookbehind is what keeps a file *name* out of this rule: `t6-whatif-iex.mjs`
  // contains the word `iex`, and `\b` is happy to match it because `-` and `.` are not
  // word characters. Measured 2026-11-25 on the real corpus: 3 commands that merely
  // moved or redirected that file were refused until the preceding character had to be
  // something other than `-` and a word character.
  const calls = statement.matchAll(/(?<![-\w])(?:Invoke-Expression|iex)\b\s*([^\n;|]*)/gi);
  let sawCall = false;
  for (const call of calls) {
    sawCall = true;
    const argument = call[1].trim();
    // `… | iex` takes its text from the pipe, which is not in this statement at all. That
    // is the same opacity as a variable, and it used to be read as "nothing after iex, so
    // nothing to read" — measured 2026-11-25: `@'…Remove-Item x…'@ | iex` was allowed while
    // `iex $b` with the same content was refused.
    if (argument.length === 0) return true;
    if (/^(['"])(?:(?!\1)[\s\S])*\1\s*$/.test(argument)) continue;
    return true;
  }
  return sawCall ? false : false;
}

/**
 * Map a path as written in Git Bash (MSYS) onto the Windows path it denotes.
 *
 * Git Bash resolves `/c/Users/x` to `C:\Users\x`, and `/cygdrive/c/...` the same
 * way, but handing the raw string to `file_trash` makes Node's Windows resolver
 * read it as `<cwd drive>:\c\Users\x` — a different location. Only the
 * drive-mapped forms are translatable without guessing: `~` is expanded by the
 * shell, and `/tmp`, `/usr`, `/proc` are MSYS mount points whose real targets are
 * installation-specific.
 *
 * @param operand - one delete operand.
 * @returns `{ path }` with the Windows form, or `{ refuse }` with the reason.
 */
function translatePosixPath(operand) {
  // A UNC path written with forward slashes (`//host/share/x`) is a Windows network
  // path, not a POSIX one: both shells accept it, and Node resolves it to
  // `\\host\share\x`. Left alone so it reaches the share handling instead of being
  // refused as an unmappable mount point.
  if (/^\/\/[^/]/.test(operand)) return { path: operand };
  if (operand === '~' || operand.startsWith('~/') || operand.startsWith('~\\')) {
    return {
      refuse:
        'Refusing a delete whose target is `~`: the shell expands home to a path this plugin cannot see. ' +
        'Write the real location (a Windows path, or a path relative to the working directory) and hand that to file_trash.',
    };
  }
  if (!operand.startsWith('/')) return { path: operand };
  // `/` is the same root in both shells; leave it for the forbidden-target rule
  // so the refusal says "filesystem root" rather than "unmappable mount point".
  if (operand === '/') return { path: operand };
  const mapped = /^\/cygdrive\/([A-Za-z])(\/.*)?$/.exec(operand)
    ?? /^\/([A-Za-z])(\/.*)?$/.exec(operand);
  if (mapped === null) {
    // "Resolve it first" told the caller what to do without saying how, and on this machine
    // `/tmp` is not guessable — the mapping depends on the installation. Measured 2026-11-25.
    return {
      refuse:
        `Refusing a delete that targets the POSIX path "${operand}": that is a Git Bash / MSYS mount point, not a ` +
        'Windows path, so the real location cannot be proven. Get the real location with `cygpath -w ' +
        `${operand}\` (in Git Bash), then pass that Windows path to file_trash — the same delete with the ` +
        'resolved path is accepted as-is.',
    };
  }
  const rest = (mapped[2] ?? '/').replace(/\//g, '\\');
  return { path: `${mapped[1].toUpperCase()}:${rest}` };
}

/**
 * Find a wipe program named inside a body that is handed to a child
 * interpreter (`bash -c "shred -u x"`). The body is shell text, so the name is
 * not in program position here and `wipeProgramIn` cannot see it.
 *
 * Scoped by the interpreter's language. A shell body *is* shell text, so the name
 * anywhere in it may run. A `node -e` / `python -c` body is not: `console.log(
 * 'shred')` erases nothing, and matching the word there refused a documentation
 * edit that quoted the name (measured 2026-11-15). For those interpreters the name
 * counts only where it is handed to a process-spawning call.
 *
 * @param statement - one statement, already split from the command.
 * @returns the matched name, or `undefined`.
 */
function wipeProgramInInlineBody(statement) {
  if (!INLINE_BODY_FLAGS.test(statement)) return undefined;
  const isShell = SHELL_INTERPRETERS.test(commandWord(statement).replace(/\.exe$/i, ''));
  if (!isShell) {
    // A destructured child_process import makes the call site a bare `execSync(...)`,
    // which SPAWN_CALL's dot-prefixed branches do not reach.
    const spawned = SPAWN_CALL.exec(statement)
      ?? (SPAWN_DESTRUCTURED.test(statement) ? SPAWN_DESTRUCTURED.exec(statement) : null);
    if (spawned === null) return undefined;
    const tail = statement.slice(spawned.index);
    const named = WIPE_NAME_IN_BODY.exec(tail);
    return named === null ? undefined : named[0].toLowerCase();
  }
  // A shell command line is read by `wipeProgramIn`, which knows where the program sits
  // and can tell `-c "shred -u x"` from `-c "Get-Command shred"`. Matching the wipe name
  // anywhere in the statement refused the second, and could not see past a `&&`.
  return undefined;
}

/**
 * Classify one statement as a delete we can rewrite.
 * @param statement - one statement string.
 * @returns the verb plus its operand tokens, or `undefined` when not a delete.
 */
function parseDeleteStatement(statement) {
  // Segments keep the quoting; `tokens` is the text-only view every other step uses.
  const segments = tokenizeSegments(statement);
  const tokens = segments.map((segment) => segment.text);
  if (tokens.length === 0) return undefined;

  const known = new Set([
    ...PS_DELETE_VERBS,
    ...PS_DELETE_ALIASES,
    ...POSIX_DELETE_VERBS,
  ]);

  // The verb is read through `programName`, so a path-qualified or backtick-escaped
  // spelling names the same program: `C:\Windows\System32\rm.exe`, `R`emove-I`tem`.
  const verbOf = (token) => programName(token).replace(/\.(?:exe|com|bat|cmd|ps1|sh)$/, '');

  /** cmd-style switches (`del /s /q …`). A single letter, never `/c` (a Git Bash root). */
  const CMD_SWITCHES = /^\/(?:[sqfpotaodvwxlnruyighe])$/i;

  // A delete can be wrapped so that the verb is not the first token but is
  // still the whole statement's action: `(Remove-Item $p)` groups it, and
  // `$x = Remove-Item $p` binds its output. In both shapes the verb is a whole
  // token and everything after it is its operand list, so step over the wrapper
  // instead of dropping the statement.
  //
  // Only leading `(`, `$(`, `@(`, `&`, `.` and a `$name =` / `$env:name =`
  // assignment are skipped. A general "find the verb anywhere" scan is not used
  // here on purpose: it would re-introduce the whole-text matching that made
  // `del L[a:b+1]` inside a Python body look like a shell delete.
  for (let guard = 0; guard < tokens.length; guard += 1) {
    const t = tokens[0];
    // A wrapper that is its own token: `(`, `$(`, `@(`, `&`, `.`, `=`.
    if (/^(?:[(\[{@&.]+|\$\(|=)$/.test(t)) {
      tokens.shift();
      continue;
    }
    // A wrapper glued to the verb: `(Remove-Item`, `@(Remove-Item`.
    const glued = /^[(\[{@&]+(.+)$/.exec(t);
    if (glued !== null) {
      tokens[0] = glued[1];
      continue;
    }
    // `$x =` as two tokens, or `$x=` glued to its value.
    if (/^\$[A-Za-z_][\w:]*$/.test(t) && tokens[1] === '=') {
      tokens.splice(0, 2);
      continue;
    }
    const assign = /^\$[A-Za-z_][\w:]*\s*=\s*(.+)$/.exec(t);
    if (assign !== null) {
      tokens[0] = assign[1];
      continue;
    }
    break;
  }
  if (tokens.length === 0) return undefined;

  // `xargs <verb>` executes the verb with targets read from stdin. Step past
  // the wrapper (and its own flags) so the delete is recognised at all — the
  // target set stays unknowable, which is why OPAQUE_CONSTRUCTS denies it.
  if (tokens[0].toLowerCase() === 'xargs') {
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      // `-I{}` consumes the next token as its placeholder replacement.
      if (/^-i$/i.test(tokens[i])) i += 1;
      i += 1;
    }
    if (i < tokens.length && known.has(verbOf(tokens[i]))) {
      return {
        verb: verbOf(tokens[i]),
        operands: [],
        recursive: false,
        force: false,
        preserveRoot: false,
        statement,
        viaXargs: true,
      };
    }
    return undefined;
  }

  const verb = verbOf(tokens[0]);
  // Skip a leading `PowerShell -Command` style wrapper is out of scope: the
  // guard denies those via OPAQUE_CONSTRUCTS or treats the wrapper as the verb.
  if (!known.has(verb)) return undefined;

  const operands = [];
  let recursive = false;
  let force = false;
  let preserveRoot = false;
  let splat = false;

  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i];
    // `del /s /q C:\tmp\a.txt`: a cmd-style switch is not a target. Left in the operand
    // list it became a path to recycle, and `del /s /q C:\tmp\*.log` told the caller to
    // `file_trash ["/s", "/q", …]` — which resolves to the roots of drives S: and Q:
    // (measured 2026-11-26). Only the cmd spellings are affected; `rm /tmp/x` keeps its
    // absolute path.
    if (CMD_SWITCHES.test(tok) && /^(?:del|erase|rd|rmdir)$/.test(verb)) continue;
    if (tok.startsWith('-')) {
      const flag = tok.toLowerCase();
      if (flag === '-recurse' || flag === '-r') recursive = true;
      if (flag === '-force' || flag === '-f') force = true;
      if (flag === '--no-preserve-root') preserveRoot = true;
      // A flag that takes a value is not a target: without this, `-ErrorAction
      // SilentlyContinue` made "SilentlyContinue" a path to recycle, and the
      // redirect message told the model to `file_trash` a value name. The two
      // path flags are the exception — their value *is* the target.
      const bare = flag.replace(/:.+$/, '');
      // Switches take no value, so whatever follows is a real operand.
      // `-WhatIf:$false` / `-Confirm:$false` glue their boolean on; strip it and
      // keep going, otherwise `$false` becomes a "path to recycle".
      if (SWITCH_PARAMETERS.has(bare)) continue;
      const takesValue = FLAGS_TAKING_VALUE.has(flag);
      const isPathFlag = flag === '-path' || flag === '-literalpath';
      if ((takesValue || isPathFlag) && i + 1 < tokens.length) {
        if (isPathFlag) operands.push({ text: unquote(tokens[i + 1]), quoted: segments[i + 1]?.quoted === true });
        i += 1;
      }
      continue;
    }
    // Combined short flags such as `-rf`.
    if (/^-[a-z]{2,}$/i.test(tok)) {
      const flags = tok.slice(1).toLowerCase();
      if (flags.includes('r')) recursive = true;
      if (flags.includes('f')) force = true;
      continue;
    }
    // `Remove-Item @targets` splats an array whose contents only exist at run
    // time. Treating "@targets" as a literal path would recycle a file that
    // happens to be named that; the caller refuses instead (see below).
    if (tok.startsWith('@')) splat = true;
    operands.push({ text: unquote(tok), quoted: segments[i]?.quoted === true });
  }

  // PowerShell accepts a comma-separated operand list: `Remove-Item a, b`. The
  // tokenizer keeps the separator glued to the preceding token, so split it off
  // and treat each element as its own operand. A closing bracket glued to the
  // last operand (`(Remove-Item C:\x)`) is stripped for the same reason: it is
  // the wrapper's, not part of the path.
  //
  // A **quoted** operand is never split — the comma belongs to the name.
  // `Remove-Item "[a,b].txt"` is one file, and splitting it told the caller to
  // recycle `[a` and `b].txt`. Measured 2026-11-25.
  const expanded = [];
  for (const operand of operands) {
    const pieces = operand.quoted ? [operand.text] : operand.text.split(',');
    for (const piece of pieces) {
      const trimmed = piece.trim().replace(/^[)\]}]+/, '').replace(/[)\]}]+$/, '');
      if (trimmed.length > 0) expanded.push(trimmed);
    }
  }

  // A delete verb with no operands still has to be reported: its targets come
  // from somewhere else (stdin, a splat, a pipeline). Returning `undefined` here
  // would make the statement indistinguishable from a non-delete, which is how
  // `xargs -I{} rm -f` slipped through after braces became separators.
  return { verb, operands: expanded, recursive, force, preserveRoot, splat, statement };
}

/**
 * Denial verdict for touching the Recycle Bin, naming the vector that was seen.
 * @param what - the command, API or mechanism that would empty or modify the bin.
 * @returns the verdict object.
 */
function emptyRecycleVerdict(what) {
  return {
    action: 'deny',
    kind: 'empty-recycle',
    reason:
      `Refusing ${what}, which empties or modifies the Recycle Bin: deleted items are kept recoverable on purpose. ` +
      'Purge them manually from Explorer if you really mean it.',
  };
}

/**
 * Decide what to do with a command that the model is about to run.
 *
 * @param command - the raw command text from the `pwsh`/`bash` tool arguments.
 * @param options - guard policy switches.
 * @param options.forbidEmptyRecycleBin - deny commands that empty the bin.
 * @param options.forbidWipe - deny permanent-erase tools.
 * @param options.blockScriptDeletes - deny inline script text containing deletes.
 * @param options.blockTruncatingWrites - deny in-place rewrites that can destroy
 *   the only copy of a file's content (see `rewrite-guard.js`).
 * @param options.blockEmptyWrites - deny writes that provably leave the target with no
 *   content (`Clear-Content`, `Set-Content … -Value ''`, `truncate -s 0`, a bare `>`).
 * @param options.dialect - which shell language the command is written in
 *   ('pwsh' or 'bash'). Defaults to 'pwsh'. Dialect-scoped rules such as the
 *   `$( … )` command-substitution check only apply to their own shell.
 * @returns a verdict object.
 */
export function classifyCommand(command, options = {}) {
  const {
    forbidEmptyRecycleBin = true,
    forbidWipe = true,
    blockScriptDeletes = true,
    blockTruncatingWrites = true,
    blockEmptyWrites = true,
    dialect = 'pwsh',
  } = options;

  if (typeof command !== 'string' || command.trim().length === 0) {
    return { action: 'allow' };
  }

  // Both of the next two rule tables are judged per statement, not per command
  // text: the evidence for "this command runs a wipe tool" is a word in program
  // position, and "this command touches the bin" is a delete verb plus a bin
  // path in the *same* statement. Whole-command matching made an unrelated
  // string literal convict the rest of the line.
  const statements = splitStatements(command);
  // A body handed in through -EncodedCommand is judged like any other
  // statement: the flag only hides it from a human reading the command line.
  // Both decoders read raw text, so here-string bodies are blanked first: a here-string
  // that quotes a `Create(…)` call is documentation, not a call. See `maskHereStrings`.
  const scannable = maskHereStrings(command);
  const bodyStatements = decodedInlineBodies(scannable);
  // `[scriptblock]::Create` is `Invoke-Expression` with a different name; its literal
  // body joins the same per-statement checks.
  const judged = [...statements, ...bodyStatements, ...decodedScriptBlockBodies(scannable)];

  // `git` destroys working-tree content without naming a delete verb, so it is asked
  // about directly rather than through the delete parser. Judged with the other delete
  // rules, not behind `blockTruncatingWrites`: it is a delete, and tying it to the rewrite
  // switch meant turning that switch off also turned `git clean -fd` off.
  for (const statement of judged) {
    const destroyed = gitDestroysWorktree(statement);
    if (destroyed !== undefined) {
      return {
        action: 'deny',
        kind: destroyed.kind,
        reason: `${destroyed.what}. ${destroyed.recipe}`,
      };
    }
  }

  if (forbidEmptyRecycleBin) {
    for (const statement of judged) {
      for (const { re } of EMPTY_RECYCLE_RULES) {
        if (re.test(statement)) {
          return {
            action: 'deny',
            kind: 'empty-recycle',
            reason:
              'Emptying or reaching into the Recycle Bin is disabled by the recycle-bin guard. ' +
              'Deleted items are kept recoverable on purpose; purge them manually from Explorer if you really mean it.',
          };
        }
      }
      // The cmdlet by command word: covers `Clear-RecycleBin`, `& "Clear-RecycleBin"`
      // and `pwsh -Command "Clear-RecycleBin"` in one place.
      if (commandWordsOf(statement).some((w) => EMPTY_BIN_COMMAND.test(w))) {
        return emptyRecycleVerdict('Clear-RecycleBin');
      }
    }
    if (EMPTY_BIN_API.test(command)) {
      return emptyRecycleVerdict('the SHEmptyRecycleBin API');
    }
    // Shell verbs driven over bin items are how Explorer empties the bin one
    // item at a time: `InvokeVerb('delete')` on a bin item is permanent, not a
    // recycle. Reading the bin (Move-Item out of $R, listing $I records, listing
    // which verbs an item offers) stays allowed — only *driving* is refused.
    //
    // Judged per statement, so a bin reference in one statement and a `DoIt()` in
    // another cannot convict each other; and so that `$i.InvokeVerb('delete')` on
    // its own — no `Namespace(10)` text anywhere — is still caught, which it was
    // not until 2026-11-24.
    // Reaching the bin as an object is allowed to travel across statements: the items
    // `NameSpace(0xA)` yields flow down the pipe, so the verb that drives them lives in
    // a later statement. A bare `$Recycle.Bin` path does not travel — it is also plain
    // text, and appears in search patterns and file arguments.
    const binObjectAnywhere = BIN_OBJECT_REF.test(command);

    for (const statement of statements) {
      // Skip the loop early when the statement cannot involve the bin at all:
      // `DoIt(`/`InvokeVerb(` and a bin reference are the only triggers, and neither
      // appears in ordinary commands. The four regexes below run per statement, so a
      // single cheap guard keeps this off the common path (measured 2026-11-24).
      if (!BIN_TOUCH.test(statement)) continue;
      const referencesBin = BIN_OBJECT_REF.test(statement) || BIN_PATH_REF.test(statement) || binObjectAnywhere;
      const drivesDoIt = /\.DoIt\s*\(/i.test(statement);
      const drivesVerb = /\bInvokeVerb\s*\(/i.test(statement);
      // `InvokeVerb()` with no argument runs the item's **default** verb, which the
      // text does not name — the same opacity as `DoIt()`. Measured 2026-11-25: it
      // was allowed.
      const drivesDefaultVerb = /\bInvokeVerb\s*\(\s*\)/i.test(statement);
      const restores = BIN_VERB_RESTORE_ARG.test(statement);
      const deletes = BIN_VERB_DELETE_ARG.test(statement);

      // `DoIt()` runs whatever verb is selected; the selection is not in the text,
      // so it is never treated as a restore — a comment saying "restore" is not a
      // verb argument.
      if (drivesDoIt && (referencesBin || !restores)) {
        return emptyRecycleVerdict("the Recycle Bin's own shell verbs (DoIt)");
      }
      if (drivesVerb && !restores) {
        if (referencesBin || deletes || drivesDefaultVerb) {
          return emptyRecycleVerdict("the Recycle Bin's own shell verbs (InvokeVerb)");
        }
      }
    }
  }

  if (forbidWipe) {
    for (const statement of judged) {
      const program = wipeProgramIn(statement) ?? wipeProgramInInlineBody(statement);
      if (program === UNREADABLE) {
        return {
          action: 'deny',
          kind: 'opaque',
          reason:
            'Refusing a command whose launchers are nested too deeply to read: each layer starts another shell, '
            + 'and past a few levels this guard cannot say what finally runs. Flatten it, or delete with the '
            + 'file_trash tool directly.',
        };
      }
      if (program !== undefined) {
        return {
          action: 'deny',
          kind: 'wipe',
          reason: `${WIPE_REASON} ("${program}" erases the data instead of moving it.)`,
        };
      }
    }
    // `cipher /w` and `format D:` are judged where `shred` is judged — see VOLUME_WIPE_ARGS.
  }

  // Opaque constructs: refuse rather than risk moving the wrong path.
  // Rules may be dialect-scoped; skip any that do not apply to this shell.
  for (const { re, what, dialects } of OPAQUE_CONSTRUCTS) {
    if (Array.isArray(dialects) && !dialects.includes(dialect)) continue;
    if (re.test(command)) {
      const hasDelete = judged.some((s) => parseDeleteStatement(s) !== undefined);
      if (hasDelete) {
        return {
          action: 'deny',
          kind: 'opaque',
          reason:
            `Refusing a delete that uses ${what}: the target set cannot be proven safe to rewrite. ` +
            'Call the file_trash tool with explicit literal paths instead.',
        };
      }
    }
  }

  // Erasing constructs that carry no shell delete verb at all. Denied outright:
  // there is no operand list to redirect to `file_trash`.
  for (const { re, what, dialects } of ERASE_CONSTRUCTS) {
    if (Array.isArray(dialects) && !dialects.includes(dialect)) continue;
    if (re.test(command)) {
      return {
        action: 'deny',
        kind: 'erase-api',
        reason:
          `Refusing ${what}: it unlinks files without a delete command, so nothing can be routed to the ` +
          'Recycle Bin. Use the file_trash tool with explicit literal paths instead.',
      };
    }
  }

  if (blockScriptDeletes) {
    // A delete that runs inside a child process cannot be routed to the Recycle
    // Bin: the shell only sees the interpreter, and the erase happens after the
    // guard has finished.
    //
    // Every rule below is judged per *statement*, not per command text. The rule
    // this replaces matched across the whole command, which meant a benign
    // `python -c "…del d['a']…"` was refused as soon as any other statement in
    // the same command mentioned `bash` — one statement's evidence convicted
    // another statement's work. Splitting first keeps the evidence local.
    // `judged` also carries statements decoded out of `-EncodedCommand`, so a
    // delete cannot hide in a base64 body.
    const statements = judged;

    // 0. A shell invoked through a variable. Which program runs is not in the text,
    //    so an inline body cannot be judged — refuse rather than assume it is
    //    harmless. Only when the statement has an inline body: `& $cmd` alone runs
    //    whatever the variable holds, and that is caught elsewhere if it deletes.
    for (const statement of statements) {
      if (invokesShellVariable(statement)) {
        return {
          action: 'deny',
          kind: 'opaque',
          reason:
            'Refusing a shell invoked through a variable (`$name -c "…"`): which program runs is only known at ' +
            'run time, so a delete inside the command string cannot be routed to the Recycle Bin. ' +
            'Call the interpreter directly, or run the delete as a file_trash tool call.',
        };
      }
    }

    // 0b. A script block built from something that is not a literal. The text to run
    //     is only known at run time, so it gets the same answer as `iex $var`: refuse
    //     rather than assume the unreadable body is harmless.
    for (const statement of statements) {
      // A here-string body is data; blank it before asking whether this statement builds an
    // expression from something unreadable.
    const scannable = maskHereStrings(statement);
    if (opaqueScriptBlock(scannable) || opaqueInvokeExpression(scannable)) {
        return {
          action: 'deny',
          kind: 'opaque',
          reason:
            'Refusing an expression that is built at run time (`Invoke-Expression $var`, '
            + '`[scriptblock]::Create(<not a literal>)`): the text it will run cannot be read, so a delete '
            + 'inside it cannot be routed to the Recycle Bin. Pass the delete to `file_trash` as a direct '
            + 'tool call instead.',
        };
      }
    }

    // 1. A shell's inline body that **runs** a delete.
    //    `pwsh -Command "Remove-Item C:\x"`, `bash -c "rm -rf /tmp/x"`.
    //    Scoped to shells: in Python or Ruby, `del` and `rm` are that
    //    language's own syntax, so they are judged by rule 2 instead.
    //
    //    Judged per statement of the body, not by finding the verb anywhere in it. A body
    //    that only *prints* the verb — `bash -c "echo Remove-Item x"` — spawns no delete,
    //    and refusing it made writing a fixture or a note about the guard impossible
    //    inline. Measured 2026-11-25. Splitting first keeps the two apart: in
    //    `bash -c "echo x; rm -rf /"` the second statement still starts with `rm`.
    for (const statement of statements) {
      // A here-string body is data. `@'…'@` can hold an entire here-doc of prose about
      // shells and deletes without running either, so it is blanked before this scan.
      const scanned = maskHereStrings(statement);
      const shellInterp = SHELL_NAME_ANYWHERE.test(scanned);
      // The argument-list spelling is normalized first: `-ArgumentList '-c','…'` puts
      // the flag and its body behind a comma, which the flag pattern cannot see.
      const inlineBody = INLINE_BODY_FLAGS.test(normalizeArgumentList(scanned));
      const body = shellInterp && inlineBody ? inlineBodyText(normalizeArgumentList(scanned)) : undefined;
      const bodyDeletes = body !== undefined
        && splitStatements(body).some((inner) => parseDeleteStatement(inner) !== undefined);
      if (bodyDeletes) {
        return {
          action: 'deny',
          kind: 'script',
          reason:
            'Deletes inside an inline shell command string are disabled by the recycle-bin guard: the erase ' +
            'happens inside the child process and would bypass the Recycle Bin. ' +
            'Run the delete as a direct file_trash tool call instead.',
        };
      }
    }

    // 2. A non-shell inline body that calls a real erasing API.
    //    `node -e "fs.rmSync(...)"`, `python -c "shutil.rmtree(...)"`.
    //
    //    Judged across the whole command on purpose, unlike rules 1 and 3: an
    //    inline body is routinely multi-line (`python -c @' … '@`), so the
    //    interpreter sits on one line and the erase call several lines later.
    //    Per-statement matching would miss exactly those. The cross-statement
    //    risk that motivated splitting — a shell word in one statement
    //    convicting another — does not apply here: `shutil.rmtree` and
    //    `fs.rmSync` are not words any other statement would contain by accident.
    // The same masking applies: a here-string can quote `fs.rmSync(…)` in prose without
    // running it. Both scans read raw text, so they read the blanked copy.
    const scannable = maskHereStrings(command);
    const otherInterp = /\b(?:node|python|python3|perl|ruby)\b/i.test(scannable);
    const inlineBody = INLINE_BODY_FLAGS.test(scannable);

    // 2a. A program whose string is handed to a **shell** runs whatever that string says.
    //     `node -e "execSync('Remove-Item x')"` and `python -c "os.system(<delete>)")` are
    //     shell deletes with one layer of indirection. Nothing else here looked at them:
    //     `PROGRAMMATIC_ERASE` only knows the deleting APIs (`rmSync`, `rmtree`), and
    //     `SPAWN_CALL` was consulted only when the payload named a wipe program. Measured
    //     2026-11-25 — both of those were allowed while the direct spelling was refused.
    //
    //     Scoped to the body: a program that merely *prints* the verb (`console.log('…')`)
    //     spawns nothing, so `SPAWN_CALL` does not match it and it stays allowed.
    if (otherInterp && inlineBody && SPAWN_CALL.test(scannable)) {
      const body = inlineBodyText(scannable) ?? '';
      if (SHELL_DELETE_VERB.test(body)) {
        return {
          action: 'deny',
          kind: 'script',
          reason:
            'Refusing a delete handed to a shell from inside a program: the child process runs the command '
            + 'itself, so the erase never reaches the Recycle Bin. '
            + 'Call file_trash with the paths directly. If the command is text you are only assembling or '
            + 'printing, put it in a file and run the file — a string built inline cannot be told apart from '
            + 'one that runs.',
        };
      }
    }

    if (otherInterp && inlineBody && PROGRAMMATIC_ERASE.test(scannable)) {
      return {
        action: 'deny',
        kind: 'script',
        reason:
          'Deletes inside an inline program string are disabled by the recycle-bin guard: the erase happens '
          + 'inside the child process and would bypass the Recycle Bin. '
          + 'Call file_trash with the paths directly. If the delete is only text you are assembling or '
          + 'printing — a test fixture, a document, a script you are writing — put that text in a file and run '
          + 'the file; inline text cannot be told apart from a command.',
      };
    }

    // 3. Writing a script file whose body contains a delete, then running it by
    //    path, is the escape hatch this plugin's own README documents. The guard
    //    cannot read the body back, but it can refuse to let the write happen.
    //
    //    Judged across the whole command: a pipe is a statement separator here,
    //    so `"Remove-Item x" | Out-File clean.ps1` would otherwise be two
    //    statements — the delete text in one, the write target in the other, and
    //    neither one guilty on its own. The write target (`.ps1`, `.sh`, `.py`)
    //    is specific enough that no unrelated statement carries it by accident.
    if (
      (SCRIPT_WRITE_REDIRECT.test(command) || SCRIPT_WRITE_CMDLET.test(command)) &&
      SHELL_DELETE_VERB.test(command)
    ) {
      return {
        action: 'deny',
        kind: 'script',
        reason:
          'Refusing to write a script file containing a delete: a script run by path executes its deletes ' +
          'inside a child process, where they bypass the Recycle Bin. ' +
          'Run the delete as a direct file_trash tool call instead.',
      };
    }
  }


  // Content destroyed without a delete verb: an in-place rewrite of the only
  // copy. Judged before the rewrite collection on purpose — `file_trash` is the
  // remedy for a *delete*, and moving the file away is precisely what a
  // read-modify-write is not allowed to have happened (and on a UNC share there
  // is no bin to move it into at all). Deny, and hand back the safe recipe.
  if (blockTruncatingWrites || blockEmptyWrites) {
    const risk = analyzeOverwriteRisk(command, {
      statements: judged,
      dialect,
      blockTruncatingWrites,
      blockEmptyWrites,
    });
    if (risk !== undefined) {
      return { action: 'deny', kind: risk.kind, reason: risk.reason };
    }
  }

  // Rewritable deletes: collect every operand across every statement, including
  // the ones decoded out of an -EncodedCommand body.

  // A delete verb with no operand list is a piped/receiving delete: the targets
  // arrive from the upstream command or from a splat, so they cannot be
  // enumerated. The pipeline case is caught earlier by OPAQUE_CONSTRUCTS, but a
  // bare `Remove-Item` reaching here still means "delete whatever you were
  // handed", which is never safe to wave through.
  for (const statement of judged) {
    const parsed = parseDeleteStatement(statement);
    if (parsed === undefined) continue;
    if (parsed.operands.length > 0 || parsed.splat) continue;
    return {
      action: 'deny',
      kind: 'opaque',
      reason:
        `Refusing a "${parsed.verb}" with no explicit operands: its targets come from another command, ` +
        'so they cannot be proven safe to route to the Recycle Bin. ' +
        'Call the file_trash tool with explicit literal paths instead.',
    };
  }

  const targets = [];
  const seen = new Set();
  for (const statement of judged) {
    const parsed = parseDeleteStatement(statement);
    if (parsed === undefined) continue;
    if (parsed.preserveRoot) {
      return {
        action: 'deny',
        kind: 'forbidden-target',
        reason: 'Refusing a delete that targets the filesystem root.',
      };
    }
    // `Remove-Item @targets`: the array's contents exist only at run time, so no
    // literal path can be proven. Refuse rather than recycle a file whose name
    // happens to be "@targets".
    if (parsed.splat) {
      return {
        action: 'deny',
        kind: 'opaque',
        reason:
          'Refusing a delete that splats an argument array (@name): its contents are only known at run time, ' +
          'so they cannot be proven safe to route to the Recycle Bin. ' +
          'Pass explicit literal paths to file_trash instead.',
      };
    }
    for (const rawOperand of parsed.operands) {
      // A Git Bash user writes `/c/tmp/x`; `file_trash` needs `C:\tmp\x`. The
      // translation has to happen here, where the dialect is known: `pwsh` reads
      // `/c/tmp/x` as a drive-relative Windows path, so the two shells mean
      // different things by the same string.
      let operand = rawOperand;
      if (dialect === 'bash') {
        const mapped = translatePosixPath(operand);
        if (mapped.refuse !== undefined) {
          return { action: 'deny', kind: 'opaque', reason: mapped.refuse };
        }
        operand = mapped.path;
      }

      // PowerShell providers are not file systems. `Remove-Item variable:x` deletes
      // a variable; `env:X` an environment entry; `function:x` a function. Telling
      // the model to `file_trash "variable:x"` is an instruction that cannot work —
      // the tool resolves it to a path that does not exist. Measured 2026-11-24.
      const provider = /^([A-Za-z]+):/.exec(operand);
      if (provider !== null && !/^[A-Za-z]$/.test(provider[1])) {
        const name = provider[1].toLowerCase();
        if (NON_FILE_PROVIDERS.has(name)) continue; // deletes nothing a bin could hold
        if (OTHER_PROVIDERS.has(name)) {
          return {
            action: 'deny',
            kind: 'forbidden-target',
            reason:
              `Refusing a delete that targets the ${provider[1]}: provider ("${operand}"). The Recycle Bin only ` +
              'holds files, so this cannot be routed there — and erasing it is not recoverable. ' +
              'Delete it deliberately with the provider\'s own tooling if that is really what you mean.',
          };
        }
      }

      // An operand that is itself a substitution has no provable value: the
      // shell expands it at run time. `rm -rf $(cat list.txt)` would otherwise
      // be tokenized into the literal strings `$(cat` and `list.txt)`, and
      // "recycling" those would move the wrong things. This check is
      // dialect-independent — bash allows `$( … )` as syntax, but never as an
      // unexpandable delete target.
      // A backtick in a PowerShell target is an escape character: `Get-Date` names the
      // file `Get-Date`, and `"backup`1.txt"` names `backup1.txt`. Dropping the backticks
      // recovers the name the shell will act on, so the operand can be judged like any
      // other literal. A backtick before a *special* character is not recoverable this way
      // (`n` becomes a newline, `` ` `` before a quote breaks the statement), so those
      // stay refused.
      if (dialect === 'pwsh' && operand.includes('`')) {
        if (/`[0abfnrtv'"$]/i.test(operand)) {
          return {
            action: 'deny',
            kind: 'opaque',
            reason:
              'Refusing a delete whose target contains a backtick escape for a control character or a quote: '
              + 'the name the shell acts on is not the name that was written. Write the plain name and pass '
              + 'that to file_trash.',
          };
        }
        operand = operand.replace(/`/g, '');
      }
      if (SUBSTITUTION_IN_TARGET.test(operand)) {
        return {
          action: 'deny',
          kind: 'opaque',
          reason:
            `Refusing a delete whose target is ${describeUntranslatable(operand)}: the real path is only known at `
            + 'run time, so it cannot be proven safe to route to the Recycle Bin. '
            + 'Resolve it first, then pass an explicit literal path to file_trash.',
        };
      }
      for (const { re, what } of FORBIDDEN_TARGETS) {
        if (re.test(operand)) {
          return {
            action: 'deny',
            kind: 'forbidden-target',
            reason: `Refusing a delete that targets ${what}.`,
          };
        }
      }
      // A glob cannot be handed to `file_trash`: it stats the path it is given, does not
      // expand `*`, and the redirect therefore guarantees one failed round
      // (`file_trash ["C:\tmp\*.log"]` → "no such file or directory"). Refuse and name the
      // way to get explicit paths. Measured 2026-11-26; before that only `*`, `*.ps1` and
      // `**` were refused, and only when `-Recurse` sat before the glob.
      if (/[*?]/.test(operand)) {
        return {
          action: 'deny',
          kind: 'forbidden-target',
          reason:
            `Refusing a delete whose target is a wildcard ("${operand}"): the set of files it expands to is not `
            + 'known here, and file_trash does not expand wildcards. List the entries first '
            + '(`Get-ChildItem -LiteralPath <dir> -Filter <pattern>`), then pass the explicit paths you mean '
            + 'to file_trash.',
        };
      }
      if (!seen.has(operand)) {
        seen.add(operand);
        targets.push(operand);
      }
    }
  }

  if (targets.length > 0) {
    return { action: 'rewrite', kind: 'delete', targets };
  }
  return { action: 'allow' };
}

export { splitStatements, tokenize, parseDeleteStatement, unquote, translatePosixPath };
