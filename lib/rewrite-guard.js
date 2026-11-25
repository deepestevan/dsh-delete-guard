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
 * makes a copy (`.bak`, a temp file it then verifies) — copying first is what makes
 * the write undoable, so the safe spelling is allowed untouched.
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
  // `Select-String <pattern> <file>`: the pattern is the first positional. But the
  // commonest spelling names the file with `-Path`, and `argumentsOf` already lifted
  // that value into the positional list — so `skip: 1` ate the path and
  // `Select-String -Path a.md -Pattern x | Set-Content a.md` was allowed
  // (measured 2026-11-24). Matching the path flag explicitly avoids that.
  ['select-string', { skip: 0, pathFlag: true }],
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
 *
 * Note: these are only consulted **per statement and before the overwrite** (see
 * `hasCopyStepFor`). A bare textual hit anywhere in the command is not evidence —
 * a trailing comment or a bystander string used to be enough to exempt a real
 * in-place rewrite.
 */
const BACKUP_MARKER = /\.(?:bak|backup|orig|old)\b|(?:^|[\\/\s'"`-])bak[-_.\d]/i;
const TEMP_MARKER = /\$env:(?:TEMP|TMP)\b|%TEMP%|%TMP%|New-TemporaryFile|\/tmp\/|[\\/]Temp[\\/]/i;

/**
 * A statement that writes somewhere: a write verb, a copy verb, or a redirect.
 * Used together with {@link BACKUP_MARKER} / {@link TEMP_MARKER} to decide whether
 * a statement is the copy step itself rather than merely mentioning a backup name.
 */
const COPY_DESTINATION =
  /\b(?:Set-Content|Out-File|Add-Content|Tee-Object|Copy-Item|Move-Item|cp|mv|move|New-Item)\b|>{1}(?!>)/i;

/**
 * Read verbs, matched **anywhere inside a statement**, not just as its first word.
 *
 * `Set-Content $f (Get-Content $f | Select-Object -First 10)` reads and truncates
 * `$f` in one line — the most compact spelling of the 2026-11-14 incident. Until
 * 2026-11-24 `readTargets` only looked at the statement's head, so every such form
 * was allowed (four measured variants, all `allow`).
 */
const NESTED_READ = /\b(?:Get-Content|ReadAllText|ReadAllLines|ReadAllBytes|Import-Csv|Import-Clixml|Select-String|Get-Item|OpenText|OpenRead)\s*\(?\s*([^\s)|,;]+)/gi;

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
 *
 * Two sources, and the second is the one that closes a hole:
 *
 *  - the statement's **head** verb, when it is a reader (`Get-Content $f`);
 *  - a reader **nested inside** a write statement
 *    (`Set-Content $f (Get-Content $f | Select-Object -First 10)`).
 *
 * Until 2026-11-24 only the first was checked, so a read folded into the write
 * was invisible and the whole in-place rewrite was allowed. That spelling is the
 * most compact form of the incident this rule exists for, so it is not a corner
 * case — it is the hazard with fewer keystrokes.
 *
 * @param statement - one statement.
 * @returns the operands being read.
 */
function readTargets(statement) {
  const out = [];
  const tokens = statementTokens(statement);
  const verb = tokens.length > 0
    ? commandWord(statement).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '')
    : '';
  const spec = READ_COMMANDS.get(verb);

  if (spec !== undefined) {
    const positionals = argumentsOf(tokens);
    // `Select-String` names its file with `-Path`, which `argumentsOf` already lifted
    // into the positionals — so a plain `skip: N` would drop it. The pattern then
    // reads as a file name and the real target is never compared.
    if (spec.pathFlag === true) {
      out.push(...positionals);
    } else if (spec.last === true) {
      if (positionals.length > 0) out.push(positionals[positionals.length - 1]);
    } else {
      out.push(...positionals.slice(spec.skip ?? 0));
    }
  }

  // Nested readers. Only when the statement is not already a reader itself —
  // otherwise the head scan above already covered the file, and re-running this
  // would duplicate operands (harmless, but it makes the maps noisier than needed).
  if (spec === undefined) {
    for (const match of statement.matchAll(NESTED_READ)) {
      const operand = cleanOperand(match[1]);
      if (operand.length > 0 && !/^[-)]/.test(operand)) out.push(operand);
    }
  }

  return out;
}

/**
 * Whether the command makes its own copy of what it is about to overwrite.
 *
 * **Statement-level, not textual.** The previous version short-circuited on
 * `BACKUP_MARKER.test(command)`, so any of these was exempted while truly
 * rewriting a file from its only copy (measured 2026-11-24, all three allowed):
 *
 *   Set-Content $f $t  # no .bak needed here          ← marker in a comment
 *   $f='a.md.bak'; Set-Content $f $t                   ← marker in the TARGET name
 *   $note='.bak is for wimps'; Set-Content a.md $f     ← marker in a bystander string
 *
 * A copy step has to be an actual write to a *different* path that derives from
 * the item itself, and it has to happen before the overwrite. Three conditions,
 * all decidable from the statement list:
 *
 *  1. a statement writes `<target>.bak*` / `<target>.tmp*` / `.new` / `.orig` …
 *  2. that statement comes **before** the target's last write
 *  3. the copy path is not the target path itself
 *
 * @param statements - the statements of the command.
 * @param literals - variable name → literal path, from this command's assignments.
 * @param targetKeys - the comparison keys of the file being overwritten.
 * @param targetIndex - the statement index of the last write to that file.
 * @returns whether a real copy step precedes the overwrite.
 */
function hasCopyStepFor(statements, literals, targetKeys, targetIndex) {
  // Build the target matchers once per call rather than once per statement: this
  // runs on every command that reads and rewrites a file, and constructing regexes
  // in a loop was measurable (2026-11-24: ~17 µs of added cost on 6,000 commands).
  const targetMatchers = [];
  for (const key of targetKeys) {
    if (!key.startsWith('lit:')) continue;
    const t = key.slice(4);
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    targetMatchers.push({
      bare: new RegExp(`(?:^|[\\\\/\\s"'\`])${esc}(?![.\\w-])`, 'i'),
      suffixed: new RegExp(`${esc}[._-](?:bak|backup|orig|old|tmp|new)`, 'i'),
    });
  }

  for (let i = 0; i <= targetIndex && i < statements.length; i += 1) {
    const statement = statements[i];

    // `sed -i.bak` / `perl -pi.bak`: the editor makes the backup itself, in the
    // same statement as the write. The suffix is the copy, so it counts — and this
    // is the one case where the copy is not a separate, earlier statement.
    if (/\b(?:sed|perl)\b[^\n;&|]*\s-[a-z]*i[._-](?:bak|backup|orig|old)\b/i.test(statement)) return true;

    // Every other copy step has to come strictly BEFORE the overwrite: a backup
    // taken afterwards preserves the already-destroyed content.
    if (i >= targetIndex) continue;

    const tokenText = statementTokens(statement).join(' ');

    // A copy/temp destination in this statement, on the text level, is necessary
    // but not sufficient: it also has to be a distinct path derived from the target.
    if (!COPY_DESTINATION.test(tokenText)) continue;

    // Condition 3: the copy must not be the target itself.
    const samePath = targetMatchers.some((m) => m.bare.test(tokenText) && !m.suffixed.test(tokenText));
    if (samePath) continue;

    // Any distinct backup/temp destination that this statement writes counts.
    if (BACKUP_MARKER.test(tokenText) || TEMP_MARKER.test(tokenText)) return true;
  }
  return false;
}

/**
 * Whether the command repeats statements in a way that makes textual order
 * unreliable: a read after a write may feed the *next* iteration's write.
 *
 * The previous gate only listed `for`/`foreach`/`while`, which misses the
 * commonest PowerShell spellings — `%` (ForEach-Object), `do`/`until`, `switch`,
 * and `.ForEach(`. Measured: `$fs | % { Set-Content $_ $c; $c = Get-Content $_ }`
 * was not gated.
 *
 * The keyword must be in **command or pipeline position**, not merely present:
 * `python -c "for i,l in enumerate(...)"` is a Python loop in a string, and
 * treating it as a shell loop kept a legitimate command refused.
 *
 * @param command - the full command text.
 * @param statements - the statements of the command.
 * @returns whether any repetition construct is present in executable position.
 */
function hasRepetition(command, statements) {
  for (const statement of statements) {
    const word = commandWord(statement).toLowerCase();
    if (/^(?:for|foreach|while|do|until|switch|%|foreach-object)$/.test(word)) return true;
    // `1..3 | % { … }` and `$x | ForEach-Object { … }`: the loop verb sits after a pipe.
    if (/(?:^|\|)\s*(?:%|foreach-object)\b/i.test(statement)) return true;
    if (/\.\s*foreach\s*\(/i.test(statement)) return true;
  }
  // `for(`/`foreach(` glued to a paren never tokenizes as a bare word.
  if (/(?:^|[;|&\n])\s*(?:for|foreach|while|switch)\s*\(/i.test(command)) return true;
  return false;
}

/**
 * Whether this command pins the text encoding on **both** sides of the rewrite.
 *
 * A byte-level hazard that the shape rules cannot see: `Get-Content -Raw` on a GBK
 * or UTF-16 document decodes it with the wrong code page, and `WriteAllText` then
 * writes the mojibake back as UTF-8. Nothing in the command is "wrong" — a plain
 * `.Replace` of an ASCII needle passes every count check — and the CJK content is
 * destroyed. Measured 2026-11-24: with an ASCII needle the occurrence check passes
 * and every CJK character becomes U+FFFD.
 *
 * A single, bounded substitution with both encodings stated is equivalent to the
 * `edit` tool: it changes the matched substring, leaves the rest byte-identical,
 * and cannot re-encode the file because the codec is pinned. Anything less than
 * that (no `-Encoding`, or only one side) stays refused.
 *
 * @param command - the full command text.
 * @returns whether both sides name an encoding.
 */
function hasPinnedEncoding(command) {
  // A read that states its codec: `Get-Content -Encoding utf8`, or a .NET read that
  // passes an encoding object as its second argument
  // (`::ReadAllText($path, $enc)` / `::ReadAllText('x', [Text.Encoding]::UTF8)`).
  const readPins = /Get-Content\b[^\n;&|]*\s-Encoding\s+\w+/i.test(command)
    || /::\s*(?:ReadAllText|ReadAllLines)\s*\(\s*[^,()]+,\s*[^)]+\)/i.test(command);
  // A write that states its codec: `Set-Content -Encoding utf8`, `Out-File -Encoding`,
  // or `WriteAllText(path, text, <encoding>)` — the third argument is the codec.
  const writePins = /(?:Set-Content|Out-File|Add-Content)\b[^\n;&|]*\s-Encoding\s+\w+/i.test(command)
    || /::\s*WriteAllText\s*\(\s*[^,()]+,\s*[^,()]+,\s*[^)]+\)/i.test(command);
  return readPins && writePins;
}
/**
 * Whether the command's only content change is a bounded, literal substitution.
 *
 * `$t = $t.Replace('old','new')` and `$t = $t -replace 'a','b'` change one
 * substring; they do not rebuild the document. The distinction matters because
 * the shape rules otherwise treat "read then write the same file" as one hazard,
 * and a targeted replacement is nowhere near as destructive as a slice.
 *
 * Deliberately **not** enough on its own: a `-replace` whose pattern is a
 * document-wide regex (`(?s)^.*$`, `\s+`) rewrites everything. That is why this
 * predicate is only consulted together with {@link hasPinnedEncoding}.
 *
 * @param command - the full command text.
 * @returns whether a bounded substitution is present.
 */
function hasBoundedSubstitution(command) {
  // A literal-to-literal Replace / -replace, both sides quoted.
  const literalSub = /\.\s*Replace\s*\(\s*'(?:[^'\\]|\\.){0,300}'\s*,\s*'(?:[^'\\]|\\.){0,300}'\s*\)/i.test(command)
    || /\.\s*Replace\s*\(\s*"(?:[^"\\]|\\.){0,300}"\s*,\s*"(?:[^"\\]|\\.){0,300}"\s*\)/i.test(command)
    || /\$\w+\s*-replace\s*'(?:[^'\\]|\\.){0,300}'\s*,\s*'(?:[^'\\]|\\.){0,300}'/i.test(command);

  // A bare `-replace 'a','b'` in a pipeline: `(Get-Content $f -Raw) -replace 'a','b' | Set-Content $f`.
  // `splitStatements` breaks on `|`, so the operator lands in its own statement and
  // the leading `$\w+ =` / `(` anchor above never matches it.
  const pipedSub = /(?:^|[;|]\s*|\)\s*)\(?-replace\s*'(?:[^'\\]|\\.){0,300}'\s*,\s*'(?:[^'\\]|\\.){0,300}'/i.test(command)
    || /(?:^|[;|]\s*)\(?-replace\s*"(?:[^"\\]|\\.){0,300}"\s*,\s*"(?:[^"\\]|\\.){0,300}"/i.test(command);

  // The same substitution with the needle/replacement held in variables or a mix of
  // variable and literal: `$t = $t.Replace($old, $new)`, `$c.Replace($old, "text")`.
  // Common in real work (the pair is built earlier), and equivalent to the literal
  // form as long as it stays a substitution — the wholesale-rewrite checks below
  // still apply.
  const varSub = /\.\s*Replace\s*\(\s*(?:\$[A-Za-z_][\w:]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*,\s*(?:\$[A-Za-z_][\w:]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*\)/i.test(command);

  // A table of literal pairs applied in a loop:
  //   $pairs = @( @('old1','new1'), @('old2','new2'), … ); foreach ($p in $pairs) { $t = $t.Replace($p[0], $p[1]) }
  // Same bounded substitution, just driven by data. Common for bulk renames in docs.
  const tableSub = /\$\w+\s*=\s*@\s*\(\s*@\s*\(\s*'[^']*'\s*,\s*'[^']*'\s*\)/i.test(command)
    || /\.\s*Replace\s*\(\s*\$[A-Za-z_][\w:]*\s*\[\s*0\s*\]\s*,\s*\$[A-Za-z_][\w:]*\s*\[\s*1\s*\]\s*\)/i.test(command);

  if (!literalSub && !pipedSub && !varSub && !tableSub) return false;

  // The pattern must not match the whole document. These are the shapes that turn a
  // substitution into a wholesale rewrite; with a pinned codec the bytes survive, but
  // the content does not.
  //
  // Measured 2026-11-24: `$t -replace '(?s)^.*$','x'` with `-Encoding utf8` on both
  // sides passed the old check and reduced a whole file to one character.
  const wholeDocument = /\(\?s\)\s*\^?\.[*+]\$?|\^\.[*+]\$|\\s\*\\S\*|\^\.\*\$/i.test(command);
  if (wholeDocument) return false;

  // …and no wholesale discarding/rebuilding alongside it.
  const destructive = /\[[^\]\n]*\.\.[^\]\n]*\]/.test(command)
    || /\|\s*Select-Object\s+-?(?:First|Skip|Last)\b/i.test(command)
    || /-TotalCount\b/i.test(command);
  return !destructive;
}

/**
 * Whether a statement writes `<something>.tmp/.bak` — i.e. makes a *copy* that can
 * still hold the original bytes.
 *
 * Deliberately narrow. A temp file holding the **new** content is not a backup: if
 * the transformation was semantically wrong, the original is gone just the same.
 * `read → transform → write temp → verify temp → copy temp over original` verifies
 * the output, not that the input is recoverable, so it does not qualify. This
 * guard's own deny message asks for a backup of the original first, and that is
 * the only step that makes a rewrite undoable.
 *
 * @param statement - one statement.
 * @returns whether the statement writes a temp/backup destination.
 */
function writesTempOrBackup(statement) {
  const text = statementTokens(statement).join(' ');
  if (!/\.(?:tmp|bak|backup|orig|old)\b|[-_.]tmp\b/i.test(text)) return false;
  return COPY_DESTINATION.test(text);
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
  const literals = collectLiterals(statements);

  // Per-file bookkeeping. A single global "last write" index was wrong: in
  // `Set-Content a …; Get-Content b`, it would treat b's read as a read-back of a.
  /** @type {Map<string, { expr: string, lastWrite: number }>} */
  const written = new Map();
  /** @type {Map<string, { expr: string, firstRead: number }>} */
  const read = new Map();

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];

    for (const expr of writtenTargets(statement)) {
      for (const key of exprKeys(expr, literals)) {
        const prior = written.get(key);
        written.set(key, { expr, lastWrite: index, });
        if (prior !== undefined && prior.expr !== expr) written.set(key, { expr: prior.expr, lastWrite: index });
      }
    }
    for (const expr of readTargets(statement)) {
      for (const key of exprKeys(expr, literals)) {
        if (!read.has(key)) read.set(key, { expr, firstRead: index });
      }
    }
  }

  // .NET content calls are not shell verbs, so `statementTokens` never sees them;
  // they name the file as their first argument and are the other way to rewrite a
  // file from its own bytes ([IO.File]::ReadAllText → ::WriteAllText).
  //
  // These must participate in the ORDER bookkeeping. Measured 2026-11-24: giving
  // them no statement index made the last-write lookup return -1, which emptied
  // the read set and let 223 historical `.NET` read→write commands through.
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    for (const match of statement.matchAll(DOTNET_WRITE)) {
      for (const key of exprKeys(match[1], literals)) {
        const prior = written.get(key);
        written.set(key, { expr: prior?.expr ?? match[1], lastWrite: index });
      }
    }
    for (const match of statement.matchAll(DOTNET_READ)) {
      for (const key of exprKeys(match[1], literals)) {
        if (!read.has(key)) read.set(key, { expr: match[1], firstRead: index });
      }
    }
  }

  const repeating = hasRepetition(command, statements);

  for (const [key, { expr: writtenExpr, lastWrite }] of written) {
    // The null device is plumbing, not a file.
    if (/^(?:lit:)?(?:\$null|nul|\/dev\/null)$/i.test(key)) continue;
    const readSide = read.get(key);
    if (readSide === undefined) continue;

    // Order: a read that happens only *after* the last write is a verification
    // read-back, not the source of the new content. It cannot feed a write that
    // already ran. Skipped entirely when the command repeats statements, because
    // there textual order is not execution order.
    if (!repeating && readSide.firstRead > lastWrite) continue;

    // A real copy of the target, made before the overwrite, makes the write undoable.
    if (hasCopyStepFor(statements, literals, new Set([key]), lastWrite)) continue;

    // A bounded substitution with the codec pinned on both sides is what the `edit`
    // tool does: it cannot re-encode the file and cannot drop content outside the
    // matched substring. Anything weaker stays refused — see hasPinnedEncoding.
    if (hasBoundedSubstitution(command) && hasPinnedEncoding(command)) continue;

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
