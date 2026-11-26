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

import { commandWord, maskHereStrings, splitStatementsDetailed, statementTokens, tokenizeSegments, unquote } from './shell-text.js';

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
 * The same read-then-overwrite in JavaScript, through `fs`.
 *
 * The hazard does not care which language spells it: `const s = fs.readFileSync(p); fs.writeFileSync(p, s)`
 * replaces the only copy exactly as `Get-Content f | Set-Content f` does, and a wrong slice
 * loses the file the same way. Neither pattern was known here, so a `node -e` one-liner that
 * rewrote a file from its own bytes was unguarded — measured 2026-11-25, while the PowerShell
 * spelling of the same act was refused.
 *
 * Only the first argument is read: that is where both APIs take the path. A call whose
 * argument is a variable still resolves through `exprKeys`, which is how the matching
 * against the read side works.
 */
const JS_FS_READ = /\b(?:readFileSync|readFile)\s*\(\s*([^,)]+)/gi;
const JS_FS_WRITE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile)\s*\(\s*([^,)]+)/gi;

/**
 * The same act in Python: `open(p).read()` then `open(p, 'w').write(...)`.
 *
 * The mode argument is what separates the two, so the write pattern requires a quoted mode
 * containing `w`/`a`/`x` and the read pattern requires either no mode or one with `r`.
 * A C# `File.Open(p, FileMode.Open)` passes an expression instead of a quoted mode, so it
 * matches neither.
 *
 * The first argument is captured only when it is a literal or a plain name. `[^,)]+` reached
 * past a call and stopped inside it, so `open(os.path.join(jd, '06.json'))` was recorded as
 * the file `os.path.join(jd` — which then matched nothing real and turned a read-only script
 * into an "in-place rewrite". Measured 2026-11-25.
 */
const PY_PATH_ARG = String.raw`(r?['"][^'"]+['"]|[A-Za-z_$][\w.$]*)`;
const PY_READ = new RegExp(String.raw`\bopen\s*\(\s*${PY_PATH_ARG}\s*(?:,\s*(['"])[^'"]*r[^'"]*\2)?\s*\)`, 'gi');
const PY_WRITE = new RegExp(String.raw`\bopen\s*\(\s*${PY_PATH_ARG}\s*,\s*(['"])[^'"]*[wax][^'"]*\2`, 'gi');

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
/**
 * A path that holds a copy of the original: `<target>.bak`, `.tmp`, `.new`, or a
 * `bak-<timestamp>` sibling.
 *
 * `.tmp` and `.new` are here because a copy is a copy whatever it is named — the check asks
 * whether the old content still exists somewhere, not what the suffix proves about intent.
 * `Copy-Item $f "$f.bak"` was accepted while `Copy-Item $f "$f.tmp"` was refused, and the
 * README told the caller to use a temp file. Measured 2026-11-25.
 *
 * What this does not accept: writing the **new** content to a temp file and moving it over
 * the original. That leaves no copy of the old bytes, so it is still refused — only a copy of
 * the target, taken before the write, counts (see `hasCopyStepFor`).
 */
const BACKUP_MARKER = /\.(?:bak|backup|orig|old|tmp|new)\b|(?:^|[\\/\s'"`-])(?:bak|tmp|new)[-_.\d]/i;
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
function exprKeys(expr, literals, index = Number.POSITIVE_INFINITY) {
  const t = cleanOperand(unquote(String(expr ?? '').trim()));
  if (t.length === 0) return [];
  const variable = /^\$\{?([A-Za-z_][\w:]*)\}?$/.exec(t);
  if (variable !== null) {
    const name = variable[1].toLowerCase();
    const keys = [`var:${name}`];
    const literal = literalAt(literals, name, index);
    if (literal !== undefined) keys.push(`lit:${pathKey(literal)}`);
    return keys;
  }
  if (t.includes('$') || t.includes('%')) return [];
  return [`lit:${pathKey(t)}`];
}

/**
 * The literal a variable holds at one statement index.
 *
 * A command may assign the same name twice — `$f='a'; Get-Content $f; $f='b'; Set-Content $f 'x'`
 * — and taking the last assignment for both sides reported the read of `a` as a read of `b`,
 * refusing a command that never rewrote anything in place (measured 2026-11-26). The value is
 * therefore resolved per statement, not per command.
 *
 * @param literals - variable name → `[{ index, value }]`, ascending.
 * @param name - the lower-cased variable name.
 * @param index - the statement index where the operand appears.
 * @returns the literal in force at that statement, or `undefined`.
 */
function literalAt(literals, name, index) {
  const entries = literals.get(name);
  if (entries === undefined) return undefined;
  let found;
  for (const entry of entries) {
    if (entry.index > index) break;
    found = entry.value;
  }
  return found;
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
  /** @type {Map<string, { index: number, value: string }[]>} */
  const literals = new Map();
  const deferred = [];
  const record = (name, index, value) => {
    const entries = literals.get(name);
    if (entries === undefined) literals.set(name, [{ index, value }]);
    else entries.push({ index, value });
  };
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    const assign = /^\s*\$\{?([A-Za-z_][\w:]*)\}?\s*=\s*(.+?)\s*$/.exec(statement);
    if (assign === null) continue;
    const name = assign[1].toLowerCase();
    const raw = assign[2];
    const value = unquote(raw);
    if (value.length === 0) continue;
    if (/[;(){}|]/.test(value)) continue;
    if (!value.includes('$')) {
      record(name, index, value);
      continue;
    }
    // A value with a reference in it can still become a literal once the referenced name is
    // known: `$bak = "$p.bak-20260101"` is the ordinary way to name a timestamped copy, and
    // dropping it made `Copy-Item $p $bak; …; Set-Content $p …` refused although the copy
    // was right there. Measured 2026-11-25.
    //
    // Only a **quoted** right-hand side is resolved. `$t = Get-Content $f -Raw` also holds a
    // `$`, but it is an expression, not a path; treating it as a string would put a command
    // into the literal table.
    if (/^(['"]).*\1$/s.test(raw)) {
      deferred.push([name, index, value]);
      continue;
    }
    // …and the unquoted concatenation, `$bak = $p + '.bak'`, which is the same value with
    // different syntax. Without it the copy destination stayed unknown and a rewrite that
    // did make a copy was refused.
    const concat = /^(\$[A-Za-z_][\w:]*)\s*\+\s*(['"])(.*)\2$/s.exec(raw);
    if (concat !== null) deferred.push([name, index, `$${concat[1].slice(1)}${concat[3]}`]);
  }
  // A few rounds so a chain resolves in any order; anything still holding a `$` stays
  // unknown, which is the safe direction. A reference resolves to the value in force *at
  // the assignment*, so `$b="$a.x"; $a='y'` does not borrow the later value.
  for (let round = 0; round < 4; round += 1) {
    let progress = false;
    for (const [name, index, value] of deferred) {
      if (literalAt(literals, name, index) !== undefined) continue;
      const resolved = value.replace(
        /\$\{?([A-Za-z_][\w:]*)\}?/g,
        (whole, ref) => literalAt(literals, ref.toLowerCase(), index) ?? whole,
      );
      if (resolved.includes('$')) continue;
      record(name, index, resolved);
      progress = true;
    }
    if (!progress) break;
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

  // `tr a-z A-Z < a.md > a.md` reads through a **redirection**, not a reader command, so the
  // head scan never saw the input side and the command was allowed. It empties the file: the
  // shell truncates `> a.md` before `tr` runs. Only the plain `<` form; `<<`, `<<<`, `<&` and
  // `<>` are different operators and are not file reads.
  for (const match of statement.matchAll(/(?:^|[\s;&|])<(?![<=>&])\s*([^\s;|&<>]+)/g)) {
    const operand = cleanOperand(match[1]);
    if (operand.length > 0) out.push(operand);
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
 *  4. the statement **mentions the target** — the copy has to be *of this file*
 *
 * Condition 4 is the one that was missing. Only the destination was checked, so a command
 * that backed up some *other* file satisfied the exemption for the file it was rewriting:
 * `Copy-Item b.md b.md.bak; …; Set-Content a.md $t` was allowed, and so was a statement
 * that wrote `$env:TEMP\x.tmp` with the new content. Measured 2026-11-26, after 2.4.5
 * widened the marker to `.tmp`/`.new`.
 *
 * @param statements - the statements of the command.
 * @param literals - variable name → literal assignments, for resolving a copy destination.
 * @param targetKey - the comparison key of the file being overwritten (a path when known).
 * @param targetVars - every variable this command binds to that path.
 * @param targetIndex - the statement index of the last write to that file.
 * @returns whether a real copy step precedes the overwrite.
 */
function hasCopyStepFor(statements, literals, targetKey, targetVars, targetIndex) {
  // Build the target matchers once per call rather than once per statement: this
  // runs on every command that reads and rewrites a file, and constructing regexes
  // in a loop was measurable (2026-11-24: ~17 µs of added cost on 6,000 commands).
  const targetMatchers = [];
  if (targetKey.startsWith('lit:')) {
    const t = targetKey.slice(4);
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    targetMatchers.push({
      bare: new RegExp(`(?:^|[\\\\/\\s"'\`])${esc}(?![.\\w-])`, 'i'),
      suffixed: new RegExp(`${esc}[._-](?:bak|backup|orig|old|tmp|new)`, 'i'),
    });
  }
  const variableMatchers = [...targetVars].map((name) => new RegExp(`\\$${name}\\b`, 'i'));
  const mentionsTarget = (text) => targetMatchers.some((m) => m.bare.test(text))
    || variableMatchers.some((re) => re.test(text));

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
    // A copy destination is often held in a variable (`$bak="$f.bak-20260101"; Copy-Item $f $bak`).
    // The marker is in the *value*, not in the statement text, so the text is expanded with
    // the literals in force at this statement before looking for it.
    const expanded = tokenText.replace(
      /\$\{?([A-Za-z_][\w:]*)\}?/g,
      (whole, name) => literalAt(literals, name.toLowerCase(), i) ?? whole,
    );

    // A copy/temp destination in this statement, on the text level, is necessary
    // but not sufficient: it also has to be a distinct path derived from the target.
    if (!COPY_DESTINATION.test(tokenText)) continue;

    // Condition 4: the statement has to be a copy *of the target*.
    if (!mentionsTarget(tokenText)) continue;

    // Condition 3: the copy must not be the target itself.
    const samePath = targetMatchers.some((m) => m.bare.test(tokenText) && !m.suffixed.test(tokenText));
    if (samePath) continue;

    // Any distinct backup/temp destination that this statement writes counts.
    if (BACKUP_MARKER.test(expanded) || TEMP_MARKER.test(expanded)) return true;
  }
  return false;
}

/**
 * The statement ranges that a loop repeats, as `[first, last]` indices.
 *
 * Textual order is unreliable only *inside* the body that repeats: a read after a write in
 * the same iteration may belong to the next iteration's write, so the "read-back" exemption
 * cannot be trusted there. Outside the body it is ordinary order — and applying the loop to
 * the whole command was refusing commands that iterated first and then wrote and verified a
 * temp file (measured 2026-11-26: `$tmp` written, read back, then copied over the target).
 *
 * The body is the run of statements deeper than the loop head, which also covers the
 * `for ($i = 0; …)` spelling whose header `splitStatements` breaks at the semicolons.
 *
 * @param command - the full command text.
 * @returns the ranges, in statement-index space.
 */
function loopBodies(command) {
  const detailed = splitStatementsDetailed(command);
  const ranges = [];
  for (let i = 0; i < detailed.length; i += 1) {
    const word = commandWord(detailed[i].text).toLowerCase();
    const isHead = /^(?:for|foreach|while|do|until|switch|%|foreach-object)$/.test(word)
      || /^(?:for|foreach|while|switch|until)\s*\(/.test(word)
      || /(?:^|\|)\s*(?:%|foreach-object)\b/i.test(detailed[i].text)
      || /\.\s*foreach\s*\(/i.test(detailed[i].text);
    if (!isHead) continue;
    const depth = detailed[i].depth;
    let first = -1;
    let last = -1;
    for (let j = i + 1; j < detailed.length; j += 1) {
      if (detailed[j].depth > depth) {
        if (first < 0) first = j;
        last = j;
        continue;
      }
      if (first >= 0) break;
    }
    if (first >= 0) ranges.push([first, last]);
  }
  return ranges;
}

/**
 * Whether this file's write and this file's read both sit inside one loop body.
 * @param ranges - from {@link loopBodies}.
 * @param writeIndices - statements that write the file.
 * @param readIndices - statements that read it.
 * @returns whether the textual order may span iterations.
 */
function repeatsWithin(ranges, writeIndices, readIndices) {
  return ranges.some(([first, last]) => writeIndices.some((i) => i >= first && i <= last)
    && readIndices.some((i) => i >= first && i <= last));
}

/**
 * The codec a statement names for reading, if any.
 * @param statement - one statement.
 * @returns the codec text, or `undefined`.
 */
function readCodecOf(statement) {
  const cmdlet = /Get-Content\b[^\n;&|]*\s-Encoding\s+([\w.-]+)/i.exec(statement);
  if (cmdlet !== null) return cmdlet[1];
  // `::ReadAllText($path, $enc)` / `::ReadAllText('x', [Text.Encoding]::UTF8)`.
  const dotnet = /::\s*(?:ReadAllText|ReadAllLines)\s*\(\s*[^,()]+,\s*([^)]+)\)/i.exec(statement);
  return dotnet === null ? undefined : dotnet[1].trim();
}

/**
 * The codec a statement names for writing, if any.
 * @param statement - one statement.
 * @returns the codec text, or `undefined`.
 */
function writeCodecOf(statement) {
  const cmdlet = /(?:Set-Content|Out-File|Add-Content)\b[^\n;&|]*\s-Encoding\s+([\w.-]+)/i.exec(statement);
  if (cmdlet !== null) return cmdlet[1];
  const dotnet = /::\s*WriteAllText\s*\(\s*[^,()]+,\s*[^,()]+,\s*([^)]+)\)/i.exec(statement);
  return dotnet === null ? undefined : dotnet[1].trim();
}

/**
 * Reduce a codec spelling to a comparable name: `UTF8`, `utf-8` and
 * `[System.Text.Encoding]::UTF8` all mean the same codec.
 * @param value - the codec text as written.
 * @returns the comparison key.
 */
function codecKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/^\[?(?:system\.)?text\.encoding\]?::/i, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Whether this file's read and write statements pin the **same** encoding.
 *
 * A byte-level hazard that the shape rules cannot see: `Get-Content -Raw` on a GBK or
 * UTF-16 document decodes it with the wrong code page, and the write then re-encodes the
 * mojibake. Nothing in the command is "wrong" — a plain `.Replace` of an ASCII needle
 * passes every count check — and the CJK content is destroyed. Measured 2026-11-24: with
 * an ASCII needle the occurrence check passes and every CJK character becomes U+FFFD.
 *
 * A single, bounded substitution with the *same* codec stated on both sides is equivalent
 * to the `edit` tool: it changes the matched substring, leaves the rest byte-identical,
 * and cannot re-encode the file.
 *
 * Two things this used to get wrong, both measured 2026-11-26:
 *
 *  - it accepted any token after `-Encoding` on either side, so `-Encoding utf8` on the
 *    read with `-Encoding ascii` on the write passed and turned seven CJK characters into
 *    seven `?`;
 *  - it searched the whole command text, so a pin sitting in an unrelated statement (or a
 *    string) exempted the rewrite.
 *
 * @param statements - the statements of the command.
 * @param readIndices - the statements that read this file.
 * @param writeIndices - the statements that write it.
 * @returns whether both sides name the same codec.
 */
function hasPinnedEncoding(statements, readIndices, writeIndices) {
  const readCodecs = readIndices
    .map((index) => readCodecOf(statements[index] ?? ''))
    .filter((value) => value !== undefined);
  const writeCodecs = writeIndices
    .map((index) => writeCodecOf(statements[index] ?? ''))
    .filter((value) => value !== undefined);
  if (readCodecs.length === 0 || writeCodecs.length === 0) return false;
  const keys = new Set(readCodecs.map(codecKey));
  return writeCodecs.every((codec) => keys.has(codecKey(codec)));
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
 * Whether one `sed -i` script only performs bounded substitutions.
 *
 * `sed` does not transcode: it copies bytes it does not match, so the `-Encoding` half of
 * the exemption is meaningless for it. What can still destroy a document is the *script* —
 * `/x/d` deletes every matching line, `1,$d` empties the file, and an `s` whose pattern is
 * `.*` blanks every line. A script made only of
 * `s<delim>pattern<delim>replacement<delim>` commands whose pattern cannot match the whole
 * line or the empty string is the same act as `edit`: it changes the matched text and
 * leaves the rest byte-identical.
 *
 * Measured 2026-11-26: `sed -i 's/a/b/g' f` was refused for want of an encoding it cannot
 * take, while `sed -i.bak` was allowed — the rule asked for a parameter the tool does not
 * have, and the refusal named a fix the caller could not apply.
 *
 * @param statements - the statements of the command.
 * @returns whether a `sed -i` with a bounded script is present.
 */
function sedBoundedInPlace(statements) {
  for (const statement of statements) {
    const tokens = statementTokens(statement);
    if (tokens.length < 3) continue;
    if (commandWord(statement).toLowerCase() !== 'sed') continue;
    if (!tokens.some((token) => /^-[a-z]*i/.test(token))) continue;
    // The script is the first non-flag argument that is not the last one (the file).
    const args = tokens.slice(1).filter((token) => !token.startsWith('-'));
    if (args.length < 2) continue;
    const script = args[0];
    const parts = script.split(/[;\n]/).map((part) => part.trim()).filter((part) => part.length > 0);
    if (parts.length === 0) continue;
    let bounded = true;
    for (const part of parts) {
      // `s<delim>pattern<delim>replacement<delim>flags` and nothing else.
      const head = /^s(.)(.*)$/s.exec(part);
      if (head === null) { bounded = false; break; }
      const body = head[2];
      const cut = body.indexOf(head[1]);
      if (cut <= 0) { bounded = false; break; }
      const pattern = body.slice(0, cut);
      // A pattern that can match a whole line or nothing turns `s` into a rewrite. Anchors
      // are allowed only when they still leave a literal core: `^> ` prefixes every line
      // (bounded), `^` alone or `^.*$` replaces every line (not).
      const core = pattern.replace(/^\^/, '').replace(/\$$/, '');
      if (core.length === 0 || core === '.*' || core === '.+' || core.startsWith('.*')) {
        bounded = false;
        break;
      }
    }
    if (bounded) return true;
  }
  return false;
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

  // One entry per *file*, keyed by its path when this command knows it. A variable and the
  // literal it holds at that statement are two spellings of one file, so they are folded
  // together: otherwise `$f='a.md'; … Set-Content $f …` produced two candidates, and the
  // "one file at a time" test below (and the copy-step matcher) saw two different files.
  const canonical = (key, index) => {
    if (!key.startsWith('var:')) return key;
    const literal = literalAt(literals, key.slice(4), index);
    return literal === undefined ? key : `lit:${pathKey(literal)}`;
  };

  // Per-file bookkeeping. A single global "last write" index was wrong: in
  // `Set-Content a …; Get-Content b`, it would treat b's read as a read-back of a.
  // The statement indices are kept per file so the encoding exemption can ask *that file's*
  // read and write statements for a codec, rather than any statement in the command.
  /** @type {Map<string, { expr: string, lastWrite: number, indices: number[], vars: Set<string> }>} */
  const written = new Map();
  /** @type {Map<string, { expr: string, firstRead: number, indices: number[] }>} */
  const read = new Map();

  /** Every variable that holds this path at this statement — `$f` names the file too. */
  const varsFor = (key, index) => {
    const vars = new Set();
    if (key.startsWith('var:')) vars.add(key.slice(4));
    if (key.startsWith('lit:')) {
      for (const name of literals.keys()) {
        const value = literalAt(literals, name, index);
        if (value !== undefined && `lit:${pathKey(value)}` === key) vars.add(name);
      }
    }
    return vars;
  };

  const noteWritten = (key, expr, index) => {
    const prior = written.get(key);
    written.set(key, {
      expr: prior !== undefined && prior.expr !== expr ? prior.expr : expr,
      lastWrite: index,
      indices: [...(prior?.indices ?? []), index],
      vars: new Set([...(prior?.vars ?? []), ...varsFor(key, index)]),
    });
  };
  const noteRead = (key, expr, index) => {
    const prior = read.get(key);
    if (prior === undefined) read.set(key, { expr, firstRead: index, indices: [index] });
    else prior.indices.push(index);
  };

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];

    for (const expr of writtenTargets(statement)) {
      for (const key of exprKeys(expr, literals, index)) noteWritten(canonical(key, index), expr, index);
    }
    for (const expr of readTargets(statement)) {
      for (const key of exprKeys(expr, literals, index)) noteRead(canonical(key, index), expr, index);
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
    // A here-string body is data. Without this, a note or a script that *quotes*
    // `fs.readFileSync(p)` followed by `fs.writeFileSync(p, …)` reads as doing it — which is
    // how a here-string of prose became an in-place rewrite once the `fs` patterns were added.
    const statement = maskHereStrings(statements[index]);
    // `.NET` content calls, and the JavaScript `fs` pair: neither is a shell verb, both name
    // the file as their first argument, and both rewrite a file from its own bytes.
    for (const pattern of [DOTNET_WRITE, JS_FS_WRITE, PY_WRITE]) {
      for (const match of statement.matchAll(pattern)) {
        for (const key of exprKeys(match[1], literals, index)) {
          noteWritten(canonical(key, index), match[1], index);
        }
      }
    }
    for (const pattern of [DOTNET_READ, JS_FS_READ, PY_READ]) {
      for (const match of statement.matchAll(pattern)) {
        for (const key of exprKeys(match[1], literals, index)) {
          noteRead(canonical(key, index), match[1], index);
        }
      }
    }
  }

  const loopRanges = loopBodies(command);

  // A bounded substitution exemption is only meaningful when the command rewrites one
  // file. With two in-place candidates, a substitution that belongs to one of them (or to
  // an unrelated note) would exempt the other: `$a = Get-Content a.md; $a = $a.Replace(…)`
  // with both encodings pinned, next to `$b = (Get-Content b.md).ToUpper(); Set-Content b.md $b`,
  // was allowed wholesale (measured 2026-11-26). One file at a time is what the `edit`
  // tool does anyway.
  const candidates = [...written.keys()].filter((key) => {
    if (/^(?:lit:)?(?:\$null|nul|\/dev\/null)$/i.test(key)) return false;
    return read.has(key);
  });
  const loneTarget = candidates.length === 1;

  for (const [key, { expr: writtenExpr, lastWrite, indices: writeIndices, vars }] of written) {
    // The null device is plumbing, not a file.
    if (/^(?:lit:)?(?:\$null|nul|\/dev\/null)$/i.test(key)) continue;
    const readSide = read.get(key);
    if (readSide === undefined) continue;

    // Order: a read that happens only *after* the last write is a verification
    // read-back, not the source of the new content. It cannot feed a write that
    // already ran. The one exception is a read and a write that both sit inside the same
    // loop body: there the read may belong to the next iteration.
    if (!repeatsWithin(loopRanges, writeIndices, readSide.indices) && readSide.firstRead > lastWrite) continue;

    // A real copy of the target, made before the overwrite, makes the write undoable.
    if (hasCopyStepFor(statements, literals, key, vars, lastWrite)) continue;

    // A bounded substitution with the codec pinned on both sides is what the `edit`
    // tool does: it cannot re-encode the file and cannot drop content outside the
    // matched substring. The pins are looked for in *this file's* read and write
    // statements, and the two codecs must agree — `-Encoding utf8` on the read with
    // `-Encoding ascii` on the write was accepted and turned every CJK character into
    // `?` (measured 2026-11-26).
    const bounded = loneTarget && hasBoundedSubstitution(command);
    if (bounded && hasPinnedEncoding(statements, readSide.indices, writeIndices)) continue;

    // `sed -i` cannot pin an encoding and does not transcode; a script of bounded
    // substitutions is the same act as `edit`, so it passes where the cmdlet shape would
    // need the codec. `sed -i.bak` is already covered by the copy step above. The rule is
    // not dialect-scoped: whichever tool carries the text, `sed` is the same program — a
    // model that writes `sed -i` inside a `pwsh` call runs Git's sed all the same.
    if (loneTarget && sedBoundedInPlace(statements)) continue;

    // When the only thing missing is the encoding, say so. Of the 41 `in-place-rewrite`
    // refusals in the 6,000-command sample, 28 carry a bounded substitution and no explicit
    // encoding — the most common refusal there is — and this text used to offer only the
    // copy-then-replace route, never the two-word fix. Measured 2026-11-25.
    const encodingHint = bounded && dialect !== 'bash'
      ? '\n\nThis is a bounded find-and-replace, so it passes as soon as the encoding is pinned on '
        + 'both sides: add `-Encoding utf8` to the read and to the write. Nothing else has to change.'
      : '';

    const shown = unquote(String(writtenExpr));
    const backup = dialect === 'bash'
      ? `cp "${shown}" "${shown}.bak-$(date +%Y%m%d-%H%M%S)"`
      : `Copy-Item -LiteralPath "${shown}" -Destination "${shown}.bak-$(Get-Date -f yyyyMMdd-HHmmss)"`;
    return {
      kind: 'in-place-rewrite',
      reason:
        // No claim about which came first: when both halves sit in one statement the guard
        // cannot tell, and either order loses the file (`Set-Content` truncates before the
        // read; `cat a.md > a.md` truncates before the command runs).
        `The recycle-bin guard blocked this command: it reads and writes "${shown}" in the same command, ` +
        'so the new content is derived from the only copy. If the read, the slice or the pipeline is wrong, ' +
        'the original is gone — there is nothing to restore from, and a network share has no Recycle Bin.' +
        encodingHint + '\n\n' +
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
 * A value that writes nothing: an empty literal, `$null`, or nothing at all.
 */
const EMPTY_VALUE_TOKEN = /^(?:''|""|\$null|@\(\)|\$\(\))$/i;

/**
 * Rule 3: does this command empty a file's content?
 *
 * The two shapes above are about content *derived from* the only copy. This one is the
 * plainer accident the same incident record names: a command that keeps the file and
 * removes what is in it. `Clear-Content notes.md`, `Set-Content notes.md -Value ''` and
 * `truncate -s 0 notes.md` were all allowed — the first is in the write-verb list, but
 * neither rule above fires on it because nothing is read, and the slice rule needs an
 * endpoint (measured 2026-11-26). `README` listed "overwrites that do not read the file
 * first" as out of scope, and that reasoning holds for a write that *has* new content:
 * refusing `echo x > f` would mean refusing `write`/`edit` too. It does not hold for a
 * write whose new content is nothing — there is no content to preserve by allowing it.
 *
 * What is deliberately not covered: a write that carries content (`echo x > f`,
 * `Out-File $f`), and `New-Item`, which creates rather than clears.
 *
 * @param statements - the statements of the command.
 * @returns the refusal, or `undefined`.
 */
function emptyWrite(statements) {
  for (const statement of statements) {
    const segments = tokenizeSegments(statement);
    const tokens = statementTokens(statement);
    if (tokens.length === 0) continue;
    const verb = commandWord(statement).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');
    const writes = writtenTargets(statement);
    // `statementTokens` drops empty tokens, so `-Value ''` and a positional `''` leave no
    // trace there. The quoted-empty segment is what the shell writes, so it is read from
    // the segments instead.
    const isEmptySegment = (index) => index >= 0
      && index < segments.length
      && segments[index].text === ''
      && segments[index].quoted === true;

    /** Build the refusal for one target. */
    const verdict = (target) => ({
      kind: 'empty-write',
      reason:
        `The recycle-bin guard blocked this command: it leaves "${target}" with no content, and the old content `
        + 'is not saved anywhere. If you meant to replace it, write the new content in one step. If you really '
        + 'want the file to end up empty, copy the current one first '
        + '(`Copy-Item -LiteralPath "<path>" -Destination "<path>.bak-<timestamp>"`), or create an empty file '
        + 'that does not exist yet with `New-Item -ItemType File`.',
    });

    if (verb === 'clear-content' && writes.length > 0) return verdict(writes[0]);

    if (verb === 'truncate' && writes.length > 0
      && /\btruncate\b[^\n;&|]*(?:-s|--size)[= ]*0\b/i.test(statement)) {
      return verdict(writes[0]);
    }

    // `cp /dev/null f` / `copy nul f`: the source holds no bytes.
    if ((verb === 'cp' || verb === 'copy') && writes.length > 0
      && /(?:^|\s)(?:\/dev\/null|nul)(?:\s|$)/i.test(statement)) {
      return verdict(writes[0]);
    }

    // A bare redirect truncates its target before any command runs.
    if (writes.length > 0 && (tokens[0] === '>' || tokens[0] === ':' || /^\d*>$/.test(tokens[0]))) {
      return verdict(writes[0]);
    }

    // `Set-Content <path> -Value ''` / `-Value $null` / a positional empty string.
    if ((verb === 'set-content' || verb === 'out-file') && writes.length > 0) {
      for (let i = 0; i < segments.length; i += 1) {
        const lower = segments[i].text.toLowerCase();
        if (lower === '-value' || lower === '-inputobject') {
          const next = segments[i + 1];
          if (next === undefined) return verdict(writes[0]);
          if (isEmptySegment(i + 1) || EMPTY_VALUE_TOKEN.test(next.text)) return verdict(writes[0]);
        }
      }
      // The positional form: a quoted empty string anywhere after the command word.
      for (let i = 1; i < segments.length; i += 1) {
        if (isEmptySegment(i)) return verdict(writes[0]);
      }
    }
  }
  return undefined;
}

/**
 * Rule 2: does an unchecked, offset slice endpoint feed a file write in the same
 * command?
 *
 * The rule deliberately fires on **any** write, not only on a rewrite of the source. A
 * slice can be computed in one command and written in the next (`$lines = Get-Content $f`
 * then `Set-Content $out $lines[0..($idx-2)]`), and nothing in that second command says
 * whether `$out` is the source; refusing only the single-command shape would let exactly
 * that pair through. Measured 2026-11-26: the sample holds no case where a slice lands in a
 * provably new file, so narrowing it would trade a real protection for an imagined one.
 *
 * @param command - the full command text.
 * @param statements - the statements of the command.
 * @returns the refusal, or `undefined`.
 */
function uncheckedSlice(command, statements) {
  // The write half is what turns a wrong slice into lost data. Without it the
  // command prints the wrong lines and the file survives, so it stays allowed.
  //
  // A redirect to the null device is not a write: `2>$null` and `> /dev/null` throw the
  // bytes away, so a read-only command that slices was being refused for "writing a file"
  // it never wrote (measured 2026-11-26).
  const writes = statements.some((statement) => writtenTargets(statement)
    .some((target) => !/^(?:\$null|nul|\/dev\/null)$/i.test(unquote(target).trim())));
  if (!writes) return undefined;

  // The slice is looked for in the command with data-only here-strings blanked: a commit
  // message that *quotes* `$lines[0..($idx-2)]` is documentation, not arithmetic, and it
  // was refused as if it were the incident (measured 2026-11-26).
  const scannable = maskHereStrings(command);

  const variables = new Set();
  for (const match of scannable.matchAll(/\[([^[\]\n]{0,160}?\.\.[^[\]\n]{0,160}?)\]/g)) {
    const endpoint = OFFSET_ENDPOINT.exec(match[1]);
    if (endpoint === null) continue;
    // `$lines[0..($lines.Count-1)]` cannot be null: Count is 0 for an empty array.
    if (/\.count\b/i.test(match[1])) continue;
    variables.add(endpoint[1].toLowerCase());
  }
  for (const match of scannable.matchAll(COUNT_ARG)) {
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
/**
 * The literal each variable holds, per statement — exported for the delete guard.
 *
 * The delete side needs the same table: `$p = 'C:\tmp\a.txt'; Remove-Item $p` names one
 * file, and refusing it costs a round for nothing. Sharing the function keeps the two
 * sides reading an assignment the same way.
 */
export { collectLiterals, literalAt, writtenTargets };

export function analyzeOverwriteRisk(command, options = {}) {
  const {
    statements = [],
    dialect = 'pwsh',
    blockInPlaceRewrite = true,
    blockUncheckedSliceWrite = true,
    blockEmptyWrites = true,
  } = options;
  if (typeof command !== 'string' || command.trim().length === 0) return undefined;
  if (statements.length === 0) return undefined;

  if (blockUncheckedSliceWrite) {
    // The slice rule is judged first: its message names the actual mistake and the
    // one-line fix, which is far more useful than the general "you are rewriting in
    // place" note when both apply (the incident had both).
    const slice = uncheckedSlice(command, statements);
    if (slice !== undefined) return slice;
  }

  if (blockInPlaceRewrite) {
    const rewrite = inPlaceRewrite(command, statements, dialect);
    if (rewrite !== undefined) return rewrite;
  }

  if (blockEmptyWrites) return emptyWrite(statements);
  return undefined;
}
