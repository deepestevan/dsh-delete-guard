/**
 * The overwrite guard: content destroyed without a delete verb.
 *
 * `guard.js` polices commands that *name* a delete. The 2026-11-14 incident named
 * none: `Get-Content $f` … `Set-Content -LiteralPath $f` replaced a 605-line
 * ledger with 24 lines, and every rule in `guard.js` was correctly silent —
 * there was no delete verb, no erase API, no script file. What was destroyed was
 * not a file but the file's *content*, in place, with no other copy anywhere.
 *
 * Two things follow from that, and they decide the shape of this module.
 *
 * 1. "Route it to the Recycle Bin" — the remedy every other rule ends with — is
 *    not available here. The target lived on a UNC share, and
 *    `scripts/recycle-bin.ps1` refuses those on purpose: `SHFileOperationW`
 *    erases there and reports success. So a rule of the form "recycle the old
 *    copy before the write" (proposed as R1 in the incident record) would have
 *    been a no-op exactly on the case that motivated it, and would still fail
 *    wherever the bin has no store. Prevention has to happen before the write,
 *    and recovery has to come from a copy the *command itself* makes.
 *
 * 2. The signal cannot be a verb list. Enumerating write verbs
 *    (`Set-Content`/`Out-File`/`Copy-Item -Force`/`>`/…) re-creates, one
 *    vocabulary later, the blind spot that made this incident invisible:
 *    `Export-Csv`, `[IO.File]::WriteAllText`, `sed -i`, `tee`, `dd of=`, `cp`,
 *    `truncate`, a compiler writing over its own output … any list is incomplete,
 *    and a guard that reads as complete but is not is worse than one that states
 *    its scope. So this module does not ask "is this a write verb?" and neither
 *    does it ask "did the file get smaller?" (see below). It asks two narrower
 *    questions whose answers are provable from the text.
 *
 * Rule 1 — in-place rewrite. The same file is read *and* written by one command:
 * `Get-Content f | Set-Content f`, `sed -i f`, `cat f > f`. The new content is
 * derived from the only copy, so a wrong slice, a wrong filter or a failing
 * redirect leaves nothing to restore from. Refused unless the command itself
 * makes a copy (`.bak`, a temp file it then verifies) — which is also the exact
 * workflow the incident's own §6 recommends, so the safe spelling is allowed
 * untouched.
 *
 * Rule 2 — unchecked slice endpoint. A range/slice whose endpoint is `<var> ± n`
 * and whose variable is never checked for `$null`, in a command that also writes
 * a file. In PowerShell `$lines[0..($null-2)]` is `$lines[0..-2]`, which is
 * `$lines[0,-1,-2]`: first line plus the last two (measured on pwsh 7: a
 * 10-element array yields `L1,L10,L9`). No error, no warning — a 605-line ledger
 * becomes 3 kept lines, and the write then saves that.
 *
 * Both rules require the *write* half on purpose. A read-only command that slices
 * wrongly prints wrong text — that is how the incident was noticed, and it loses
 * nothing. Refusing it would cost the model a round trip and protect nothing, so
 * a buggy slice with no write in the same command stays allowed.
 *
 * What this module deliberately does not do
 * ----------------------------------------
 * - No post-hoc size comparison. "Refuse the write if the file shrank" needs the
 *   old content to restore, and a `tools/post-execute` hook cannot roll anything
 *   back: `PostToolDecision.block` only turns the result into feedback, after the
 *   truncation already happened. Taking the copy up front needs the target set,
 *   which is the enumeration problem again; snapshotting a whole tree per shell
 *   call is O(workspace) — and would still miss the incident's file, which was on
 *   a UNC share outside every workspace root.
 * - No I/O. Pure function of the command text, like `guard.js`, so it is unit
 *   testable and cannot fail halfway through a decision.
 * - No `ask` decision. In an auto-approving deployment (this machine: approval
 *   policy `never`) `ask` resolves to allow in the same tick, which would make
 *   the rule look present and do nothing. Deny-with-a-recipe is the shape that
 *   stays honest whether or not a human is watching.
 */

import { commandWord, statementTokens, unquote } from './shell-text.js';

/**
 * Verbs that replace a file's content. Targets are read the same way
 * `parseDeleteStatement` reads delete operands: `-Path` / `-LiteralPath` /
 * `-FilePath` name the target, otherwise it is the first positional argument.
 *
 * `copy`/`move` are here because they destroy an existing destination; `tee`,
 * `dd`, `truncate` cover the bash side. `dd` names its target as `of=`.
 */
const WRITE_COMMANDS = new Set([
  'set-content',
  'clear-content',
  'out-file',
  'tee-object',
  'export-csv',
  'export-clixml',
  'set-item',
  'new-item',
  'copy-item',
  'move-item',
  'rename-item',
  'tee',
  'truncate',
  'cp',
  'copy',
  'mv',
  'move',
  'dd',
]);

/**
 * Flags whose *value* is the file being written.
 * `-Destination`/`-NewName` are how `Copy-Item`/`Move-Item`/`Rename-Item` name
 * the path that gets destroyed.
 */
const WRITE_PATH_FLAGS = new Set([
  '-path',
  '-literalpath',
  '-filepath',
  '-pspath',
  '-destination',
  '-newname',
]);

/**
 * Flags that consume the next token as a value without it being a target.
 * Without this, `Set-Content -Encoding UTF8 $f` would read `UTF8` as the file.
 */
const WRITE_VALUE_FLAGS = new Set([
  '-value',
  '-encoding',
  '-delimiter',
  '-width',
  '-inputobject',
  '-stream',
  '-filter',
  '-include',
  '-exclude',
  '-credential',
  '-erroraction',
  '-ea',
  '-errorvariable',
  '-ev',
  '-warningaction',
  '-wa',
  '-informationaction',
  '-infa',
  '-outbuffer',
  '-ob',
  '-outvariable',
  '-ov',
  '-pipelinevariable',
  '-pv',
]);

/**
 * Verbs that read a file's content. `skip` counts leading positionals that are
 * not paths (`grep <pattern> <file>`, `Select-String <pattern> <file>`,
 * `awk <program> <file>`); `last` marks the tools whose *last* positional is the
 * file (`sed 's/a/b/' <file>`).
 */
const READ_COMMANDS = new Map([
  ['get-content', { skip: 0 }],
  ['gc', { skip: 0 }],
  ['type', { skip: 0 }],
  ['import-csv', { skip: 0 }],
  ['import-clixml', { skip: 0 }],
  ['select-string', { skip: 1 }],
  ['cat', { skip: 0 }],
  ['head', { skip: 0 }],
  ['tail', { skip: 0 }],
  ['more', { skip: 0 }],
  ['less', { skip: 0 }],
  ['grep', { skip: 1 }],
  ['awk', { skip: 1 }],
  ['sort', { skip: 0 }],
  ['uniq', { skip: 0 }],
  ['sed', { last: true }],
  ['perl', { last: true }],
]);

/**
 * .NET content calls, read and write, matched by member name.
 * `[IO.File]::WriteAllText(path, text)` destroys the old content;
 * `::ReadAllText(path)` reads it. Argument 0 is the path in both.
 */
const DOTNET_READ = /::\s*(?:ReadAllText|ReadAllLines|ReadAllBytes|OpenRead|OpenText)\s*\(\s*([^,)]+)/gi;
const DOTNET_WRITE = /::\s*(?:WriteAllText|WriteAllLines|WriteAllBytes|CreateText|Create|AppendAllText|AppendAllLines)\s*\(\s*([^,)]+)/gi;

/**
 * A copy of the target made by the command itself, or a temp-then-replace step:
 * either way the old content survives somewhere before the write. This is the
 * escape hatch, and it is deliberately textual — the guard cannot run the
 * command to find out.
 */
const BACKUP_MARKER = /\.(?:bak|backup|orig|old)\b|(?:^|[\\/\s'"`-])bak[-_.\d]/i;
const TEMP_MARKER = /\$env:(?:TEMP|TMP)\b|%TEMP%|%TMP%|New-TemporaryFile|\/tmp\/|[\\/]Temp[\\/]/i;

/**
 * Slice endpoints whose value can be `$null` and which are then offset by
 * arithmetic: `$idx - 2`. The `±` is what makes the failure silent rather than
 * loud — `$null` itself indexes the last element, it does not throw.
 */
const OFFSET_ENDPOINT = /\$\{?([A-Za-z_][\w:]*)\}?\s*[-+]\s*\d/;

/** The same hazard in the parameter forms that take a count. */
const COUNT_ARG =
  /(?:-first|-skip|-last|\.substring\s*\(|\.remove\s*\()\s*\(?\s*\$\{?([A-Za-z_][\w:]*)\}?\s*[-+]/gi;

/** `.Count` / `Measure-Object` are 0 for an empty result, never `$null`. */
const SAFE_PROVENANCE = /\.count\b|\bmeasure-object\b|^\s*-?\d+\s*$/i;

/**
 * Normalize a path for comparison: separators, case, trailing separator.
 * Windows paths are case-insensitive, so `C:\Tmp\A.md` and `c:/tmp/a.md` are the
 * same file and must compare equal, or the rule misses the plainest spelling.
 * @param p - the path text.
 * @returns the comparison key.
 */
function pathKey(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Remove the grouping punctuation a statement's own wrapper leaves on an operand:
 * `(Get-Content $f)` tokenizes to `['(Get-Content', '$f)']`, and `$f)` is the same
 * file as `$f`. Without this the read side is unkeyed and a piped in-place rewrite
 * — the commonest spelling of the hazard — goes unseen.
 *
 * @param expr - the operand as written.
 * @returns the operand without leading/trailing brackets.
 */
function cleanOperand(expr) {
  let t = String(expr ?? '').trim();
  for (let i = 0; i < 2; i += 1) {
    t = t.replace(/^[({\[]+/, '').replace(/[)}\]]+$/, '');
  }
  return t;
}

/**
 * The comparison keys for one operand expression.
 *
 * A variable contributes two keys — its own name, and (when the command itself
 * assigns it a literal) the path it holds — so `Get-Content $f` matches both
 * `Set-Content $f` and `Set-Content 'C:\x\a.md'`. An interpolated string
 * (`"$f.bak"`) contributes none: its value is not knowable here, and a wrong
 * match would name a file the command never touches.
 *
 * @param expr - the operand as written.
 * @param literals - variable name → literal path, from this command's assignments.
 * @returns the keys, possibly empty.
 */
function exprKeys(expr, literals) {
  const t = cleanOperand(unquote(String(expr ?? '').trim()));
  if (t.length === 0) return [];
  const variable = /^\$\{?([A-Za-z_][\w:]*)\}?$/.exec(t);
  if (variable !== null) {
    const name = variable[1].toLowerCase();
    const keys = [`var:${name}`];
    const literal = literals.get(name);
    if (literal !== undefined) keys.push(`lit:${pathKey(literal)}`);
    return keys;
  }
  if (t.includes('$') || t.includes('%')) return [];
  return [`lit:${pathKey(t)}`];
}

/**
 * Record `$v = <literal>` assignments, which is how a command usually names the
 * file it is about to destroy (`$f = '…\台账.md'`; `Set-Content -LiteralPath $f`).
 *
 * Only single-literal right-hand sides are recorded. Anything else stays
 * unresolved — the operand key then remains `var:<name>`, which still matches the
 * read side when both sides use the same variable, and that is the common case.
 *
 * @param statements - the statements of one command.
 * @returns variable name → literal text.
 */
function collectLiterals(statements) {
  const literals = new Map();
  for (const statement of statements) {
    const assign = /^\s*\$\{?([A-Za-z_][\w:]*)\}?\s*=\s*(.+?)\s*$/.exec(statement);
    if (assign === null) continue;
    const name = assign[1].toLowerCase();
    const value = unquote(assign[2]);
    if (value.length === 0 || value.includes('$')) continue;
    if (/[;(){}|]/.test(value)) continue;
    literals.set(name, value);
  }
  return literals;
}

/**
 * Record how a variable's value was produced, for the `$null` question.
 *
 * `$idx = (… | Select-Object -First 1).LineNumber` is `$null` when the pattern
 * matches nothing; `$n = $lines.Count` is `0`. Only the second is safe to offset.
 * Anything not visible in the command counts as unproven — the guard refuses what
 * it cannot check, and this rule additionally requires a file write in the same
 * command, so "unproven" is affordable here.
 *
 * @param statements - the statements of one command.
 * @returns variable name → whether its provenance proves a non-null value.
 */
function collectProvenance(statements) {
  const safe = new Map();
  for (const statement of statements) {
    const assign = /^\s*\$\{?([A-Za-z_][\w:]*)\}?\s*=\s*(.+?)\s*$/.exec(statement);
    if (assign === null) continue;
    const name = assign[1].toLowerCase();
    const provenSafe = SAFE_PROVENANCE.test(assign[2]);
    // Any unsafe assignment outweighs a safe one: the loop may take either path.
    safe.set(name, provenSafe && (safe.get(name) ?? true));
  }
  return safe;
}

/**
 * Split a token that carries a `>` redirect into the part before it and the target
 * after it: `f.txt>f.txt` → `{ before: 'f.txt', after: 'f.txt' }`, `2>$null` →
 * `{ before: '', after: '$null' }`, `>out.md` → `{ before: '', after: 'out.md' }`.
 *
 * `>>` (append) never matches — the character class cannot span two `>`s — which
 * is the desired outcome: an append destroys nothing.
 *
 * @param tok - one token.
 * @returns the split, or `undefined` when the token carries no redirect.
 */
function splitRedirect(tok) {
  const match = /^([^\s>]*)>([^\s>]*)$/.exec(tok);
  if (match === null) return undefined;
  const before = /^(?:\d+|\*)$/.test(match[1]) ? '' : match[1];
  return { before, after: match[2] };
}

/**
 * The file expressions one statement writes.
 *
 * `Add-Content` never appears here: it is the one write that does not replace
 * anything. `Set-Content -Append` and `>>` are treated the same way. Writing to
 * the null device (`$null`, `NUL`, `/dev/null`) is still collected here and
 * discarded by the caller, because that decision belongs with the comparison, not
 * with the parsing.
 *
 * @param statement - one statement.
 * @returns the operands being written.
 */
function writtenTargets(statement) {
  const tokens = statementTokens(statement);
  if (tokens.length === 0) return [];
  const targets = [];

  // Redirection: `> f`, `>f`, `f>f`, `2> f`. `>>` appends, so it is not a rewrite;
  // `splitRedirect` cannot span two `>`s, which is what makes that automatic.
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === '>') {
      if (tokens[i + 1] !== undefined) targets.push(tokens[i + 1]);
      continue;
    }
    const redirect = splitRedirect(tok);
    if (redirect !== undefined && redirect.after.length > 0) targets.push(redirect.after);
  }

  const verb = commandWord(statement).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');
  if (verb === 'dd') {
    for (const tok of tokens) {
      const of = /^of=(.+)$/i.exec(tok);
      if (of !== null) targets.push(of[1]);
    }
    return targets;
  }

  // In-place editors: `sed -i`, `sed -i.bak`, `perl -pi`, `perl -i`. The file is
  // read and rewritten in one step by definition, which is rule 1's exact shape.
  if (verb === 'sed' || verb === 'perl') {
    if (tokens.some((t) => /^-[a-z]*i/.test(t))) {
      const positionals = argumentsOf(tokens);
      if (positionals.length > 0) targets.push(positionals[positionals.length - 1]);
    }
    return targets;
  }

  if (!WRITE_COMMANDS.has(verb)) return targets;

  // `Set-Content -Append` / `Export-Csv -Append` add to the file instead of
  // truncating it, so the statement is not a rewrite.
  if (tokens.some((t) => /^-append$/i.test(t))) return targets;

  // For copy/move/rename the *source* is read, not written: only the destination
  // is replaced. Treating `-LiteralPath` as a write target here made
  // `Get-Content $f …; Copy-Item -LiteralPath $f -Destination $g` look like an
  // in-place rewrite of `$f`.
  const isCopy = verb === 'copy-item' || verb === 'move-item' || verb === 'rename-item'
    || verb === 'copy' || verb === 'cp' || verb === 'mv' || verb === 'move';
  if (isCopy) {
    for (let i = 1; i < tokens.length; i += 1) {
      const flag = tokens[i].toLowerCase();
      if ((flag === '-destination' || flag === '-newname') && tokens[i + 1] !== undefined) {
        targets.push(tokens[i + 1]);
        i += 1;
      }
    }
    const positionals = argumentsOf(tokens);
    if (positionals.length > 0) targets.push(positionals[positionals.length - 1]);
    return targets;
  }

  const positionals = argumentsOf(tokens);
  if (positionals.length > 0) targets.push(positionals[0]);
  return targets;
}

/**
 * The positional arguments of one statement's command, with flag values consumed
 * and redirection tokens dropped.
 *
 * Both halves matter for a false positive: `sed 's/a/b/' a.txt > b.txt` has `b.txt`
 * as a *destination*, not an argument, and counting it as a positional made the
 * `sed` reader claim it was writing the file it reads (`{ last: true }`).
 *
 * @param tokens - the statement's tokens, command word first.
 * @returns the positional arguments.
 */
function argumentsOf(tokens) {
  const positionals = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === '>') {
      i += 1;
      continue;
    }
    const redirect = splitRedirect(tok);
    if (redirect !== undefined) {
      // `cat f.txt>f.txt` reads and truncates the same file in one token, which is
      // the plainest form of the hazard: the operand before the `>` is an argument.
      if (redirect.before.length > 0) positionals.push(redirect.before);
      continue;
    }
    if (tok.startsWith('-')) {
      const flag = tok.toLowerCase();
      if (WRITE_PATH_FLAGS.has(flag) && tokens[i + 1] !== undefined) {
        positionals.push(tokens[i + 1]);
        i += 1;
        continue;
      }
      if (WRITE_VALUE_FLAGS.has(flag) && tokens[i + 1] !== undefined) {
        i += 1;
        continue;
      }
      continue;
    }
    positionals.push(tok);
  }
  return positionals;
}

/**
 * The file expressions one statement reads.
 * @param statement - one statement.
 * @returns the operands being read.
 */
function readTargets(statement) {
  const tokens = statementTokens(statement);
  if (tokens.length === 0) return [];
  const verb = commandWord(statement).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');
  const spec = READ_COMMANDS.get(verb);
  if (spec === undefined) return [];

  const positionals = argumentsOf(tokens);
  if (spec.last === true) {
    return positionals.length > 0 ? [positionals[positionals.length - 1]] : [];
  }
  return positionals.slice(spec.skip ?? 0);
}

/**
 * Whether the command makes its own copy of what it is about to overwrite.
 *
 * Two spellings count, and both are what the incident's §6 safe pattern looks
 * like: a `.bak`-style destination, or a temp file that is then copied/moved over
 * the original. A bare mention of `$env:TEMP` is not enough — a command that
 * reads one temp file and writes another would otherwise be exempted.
 *
 * @param command - the full command text.
 * @returns whether a backup or verified-temp step is present.
 */
function hasCopyStep(command) {
  if (BACKUP_MARKER.test(command)) return true;
  return TEMP_MARKER.test(command) && /\b(?:Copy-Item|Move-Item|cp|mv|move)\b/i.test(command);
}

/**
 * Rule 1: is this command reading and rewriting the same file?
 *
 * @param command - the full command text.
 * @param statements - the statements of the command.
 * @param dialect - `pwsh` or `bash`, for the recipe in the message.
 * @returns the refusal, or `undefined`.
 */
function inPlaceRewrite(command, statements, dialect) {
  if (hasCopyStep(command)) return undefined;

  const literals = collectLiterals(statements);
  const written = new Map();
  const read = new Map();

  for (const statement of statements) {
    for (const expr of writtenTargets(statement)) {
      for (const key of exprKeys(expr, literals)) {
        if (!written.has(key)) written.set(key, expr);
      }
    }
    for (const expr of readTargets(statement)) {
      for (const key of exprKeys(expr, literals)) {
        if (!read.has(key)) read.set(key, expr);
      }
    }
  }

  // .NET content calls are not shell verbs, so `statementTokens` never sees them;
  // they name the file as their first argument and are the other way to rewrite a
  // file from its own bytes ([IO.File]::ReadAllText → ::WriteAllText).
  for (const match of command.matchAll(DOTNET_WRITE)) {
    for (const key of exprKeys(match[1], literals)) {
      if (!written.has(key)) written.set(key, match[1]);
    }
  }
  for (const match of command.matchAll(DOTNET_READ)) {
    for (const key of exprKeys(match[1], literals)) {
      if (!read.has(key)) read.set(key, match[1]);
    }
  }

  for (const [key, writtenExpr] of written) {
    // The null device is plumbing, not a file.
    if (/^(?:lit:)?(?:\$null|nul|\/dev\/null)$/i.test(key)) continue;
    if (!read.has(key)) continue;

    const shown = unquote(String(writtenExpr));
    const backup = dialect === 'bash'
      ? `cp "${shown}" "${shown}.bak-$(date +%Y%m%d-%H%M%S)"`
      : `Copy-Item -LiteralPath "${shown}" -Destination "${shown}.bak-$(Get-Date -f yyyyMMdd-HHmmss)"`;
    return {
      kind: 'in-place-rewrite',
      reason:
        `The recycle-bin guard blocked this command: it reads "${shown}" and then overwrites that same file, ` +
        'so the new content is derived from the only copy. If the read, the slice or the pipeline is wrong, ' +
        'the original is gone — there is nothing to restore from, and a network share has no Recycle Bin.\n\n' +
        `Do this instead (the copy step is what makes the write undoable):\n` +
        `  1. ${backup}\n` +
        '  2. write the new text to a temp file\n' +
        '  3. check it (line count or first/last line), then copy it over the original\n\n' +
        'For a find-and-replace on a document, the `edit` tool is safer than rewriting the whole file from a shell. ' +
        'For a rewrite that already copies the file to `<name>.bak-<timestamp>` first, re-run unchanged — that step is accepted.',
    };
  }
  return undefined;
}

/**
 * Rule 2: does an unchecked, offset slice endpoint feed a file write in the same
 * command?
 *
 * @param command - the full command text.
 * @param statements - the statements of the command.
 * @returns the refusal, or `undefined`.
 */
function uncheckedSlice(command, statements) {
  // The write half is what turns a wrong slice into lost data. Without it the
  // command prints the wrong lines and the file survives, so it stays allowed.
  const writes = statements.some((s) => writtenTargets(s).length > 0);
  if (!writes) return undefined;

  const variables = new Set();
  for (const match of command.matchAll(/\[([^[\]\n]{0,160}?\.\.[^[\]\n]{0,160}?)\]/g)) {
    const endpoint = OFFSET_ENDPOINT.exec(match[1]);
    if (endpoint === null) continue;
    // `$lines[0..($lines.Count-1)]` cannot be null: Count is 0 for an empty array.
    if (/\.count\b/i.test(match[1])) continue;
    variables.add(endpoint[1].toLowerCase());
  }
  for (const match of command.matchAll(COUNT_ARG)) {
    variables.add(match[1].toLowerCase());
  }
  if (variables.size === 0) return undefined;

  // An assertion anywhere in the command clears the variable: the incident's own
  // fix is one line, so the rule accepts it wherever it appears.
  const provenance = collectProvenance(statements);
  let offender;
  for (const name of variables) {
    if (provenance.get(name) === true) continue;
    if (isAsserted(command, name)) continue;
    offender = name;
    break;
  }
  if (offender === undefined) return undefined;

  return {
    kind: 'slice-risk',
    reason:
      `The recycle-bin guard blocked this command: \`$${offender}\` is offset by arithmetic in a slice endpoint, ` +
      'it is never checked for $null, and the same command writes a file. In PowerShell a null offset is not an ' +
      'error — `$lines[0..($null-2)]` is `$lines[0..-2]`, i.e. `$lines[0,-1,-2]`, the first line and the last two — ' +
      'so a 605-line file can be saved over as 24 lines with no warning anywhere.\n\n' +
      `Fix, then re-run:  if (-not $${offender}) { throw "anchor not found" }\n` +
      `Or compute the endpoint from a proven value (e.g. \`$lines.Count\`) instead of an unchecked match index. ` +
      'For the write itself, copy the original to `<name>.bak-<timestamp>` first, write a temp file, verify it, then replace.',
  };
}

/**
 * Whether the command proves a variable is not `$null` before using it.
 * @param command - the full command text.
 * @param name - the lower-cased variable name.
 * @returns whether an assertion on that variable is present.
 */
function isAsserted(command, name) {
  const v = `\\$${name}\\b`;
  const patterns = [
    `${v}\\s*-\\s*(?:eq|ne|lt|le|gt|ge)\\s*\\$null`,
    `\\$null\\s*-\\s*(?:eq|ne|lt|le)\\s*${v}`,
    `${v}\\s*-(?:eq|le)\\s*(?:0|''|"")`,
    `${v}\\s*\\?\\?`,
    `if\\s*\\(\\s*!\\s*${v}`,
    `if\\s*\\(\\s*-\\s*not\\s*\\(?\\s*${v}`,
    `if\\s*\\(\\s*${v}\\s*\\)`,
  ];
  return patterns.some((p) => new RegExp(p, 'i').test(command));
}

/**
 * Classify a command for content-destroying writes.
 *
 * @param command - the full command text.
 * @param options - `statements` (already split, including decoded bodies) and
 *   `dialect` (`pwsh` or `bash`).
 * @returns `{ kind, reason }` when the command must be refused, else `undefined`.
 */
export function analyzeOverwriteRisk(command, options = {}) {
  const { statements = [], dialect = 'pwsh' } = options;
  if (typeof command !== 'string' || command.trim().length === 0) return undefined;
  if (statements.length === 0) return undefined;

  // The slice rule is judged first: its message names the actual mistake and the
  // one-line fix, which is far more useful than the general "you are rewriting in
  // place" note when both apply (the incident had both).
  const slice = uncheckedSlice(command, statements);
  if (slice !== undefined) return slice;

  return inPlaceRewrite(command, statements, dialect);
}
