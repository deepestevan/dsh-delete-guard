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
 */

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
  '-confirm',
  '-whatif',
  '-verbose',
  '-debug',
]);

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
const WIPE_PROGRAMS = new Set(['sdelete', 'sdelete64', 'shred', 'srm', 'wipe']);

/**
 * Verbs whose following argument is itself the program that will run.
 * `Start-Process -FilePath shred …` and `cmd /c shred …` name the wipe tool as
 * an argument, so looking only at the command word would miss them.
 */
const LAUNCHER_VERBS = new Set(['start-process', 'start', 'saps', 'cmd', 'invoke-item', 'ii']);

/**
 * Erase by flag rather than by program name. Matched anywhere in the command:
 * the flag shape *is* the evidence, and no read-only command is spelled
 * `cipher /w` or `format D:`.
 */
const WIPE_FLAG_SHAPES = [
  /\bcipher\s+\/w\b/i,
  /\bcipher\s+\/w:\S+/i,
  /\bformat\s+[a-z]:/i,
];

/**
 * A wipe-program name anywhere inside the body handed to a child interpreter
 * (`bash -c "shred -u x"`). Such a body is shell text, not an operand, so the
 * argument that *calls* itself out of program position does not protect it.
 */
const WIPE_NAME_IN_BODY = /\b(?:sdelete64|sdelete|shred|srm|wipe)\b/i;

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
const BIN_NAMESPACE_REF = /Namespace\(\s*(?:10|0xa)\s*\)|shell:RecycleBinFolder|\$recycle\.bin/i;
const BIN_VERB_DRIVE = /\bInvokeVerb\s*\(|\.Verbs\s*\(\s*\)|\.DoIt\s*\(/i;

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
  { re: /`[^`]*`/, what: 'backtick command substitution', dialects: ['pwsh', 'bash'] },
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
  // Invoke-Expression / iex evaluates a string: the verb is inside the string,
  // so no statement-level verb is ever seen.
  { re: /\b(?:Invoke-Expression|iex)\b/i, what: 'Invoke-Expression / iex', dialects: ['pwsh'] },
  // `cmd /c del …` hands the delete to a child interpreter.
  { re: /\bcmd(?:\.exe)?\s+\/[ck]\b[^\n]*\b(?:del|erase|rd|rmdir)\b/i, what: 'a delete delegated to cmd.exe', dialects: ['pwsh', 'bash'] },
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
const INLINE_BODY_FLAGS = /(?:^|\s)(?:-c|-e|-Command|-EncodedCommand|--eval|--execute)\s/i;
const INTERPRETER = /\b(?:bash|sh|zsh|pwsh|powershell|node|python|python3|perl|ruby)\b/i;
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

/** Path shapes that must never be rewritten into a recycle-bin move. */
const FORBIDDEN_TARGETS = [
  { re: /^[a-z]:[\\/]?$/i, what: 'a drive root' },
  { re: /^[\\/]$/, what: 'the filesystem root' },
  { re: /^(?:\$env:SystemRoot|%SystemRoot%|[a-z]:\\Windows)(?:[\\/]|$)/i, what: 'the Windows directory' },
  { re: /^(?:\$env:ProgramFiles|%ProgramFiles%|[a-z]:\\Program Files)/i, what: 'Program Files' },
  { re: /(?:^|[\\/])\.\.(?:[\\/]|$)/, what: 'a parent-directory traversal' },
  { re: /^\$recycle\.bin$/i, what: 'the Recycle Bin itself' },
];

/**
 * Strip a single layer of PowerShell quote characters.
 * @param token - raw operand token.
 * @returns the token without surrounding quotes.
 */
function unquote(token) {
  const t = token.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/**
 * Split a command string into statements on unquoted separators, so each
 * statement can be classified independently.
 *
 * Braces are separators. PowerShell wraps a delete in a script block all the
 * time — `if (Test-Path $p) { Remove-Item $p }`, `foreach ($f in $fs) { … }`,
 * `& { … }`, `try { … }`, `… | ForEach-Object { … }` — and a splitter that only
 * honours `;` and newlines leaves the verb inside the block where the
 * first-token matcher never reaches it. That is not a theoretical gap: it is
 * exactly how a real `Remove-Item` ran unguarded on 2026-10-18, while the same
 * delete written across three lines was caught (the newline happened to be a
 * separator).
 *
 * `${name}` is the one brace form that is a variable rather than a block, so it
 * is consumed whole. Shredding it into `$` + `NAME}` would turn a delete
 * target of `${TARGET_DIR}` into a literal `$`, which is worse than missing it:
 * the redirect message would name a path that does not exist.
 *
 * @param command - full command text.
 * @returns the statement strings, trimmed and non-empty.
 */
function splitStatements(command) {
  const out = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote !== null) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '{' && buf.endsWith('$')) {
      const close = command.indexOf('}', i + 1);
      const end = close === -1 ? command.length : close + 1;
      buf += command.slice(i, end);
      i = end - 1;
      continue;
    }
    const isSep =
      ch === ';' ||
      ch === '\n' ||
      ch === '\r' ||
      ch === '|' ||
      ch === '&' ||
      ch === '{' ||
      ch === '}';
    if (isSep) {
      if (buf.trim().length > 0) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

/**
 * Tokenize a single statement into argv-like words, honouring quotes.
 * @param statement - one statement.
 * @returns the token list.
 */
function tokenize(statement) {
  const out = [];
  let buf = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < statement.length; i += 1) {
    const ch = statement[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        buf += ch;
      }
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        out.push(buf);
        buf = '';
        started = false;
      }
      continue;
    }
    buf += ch;
    started = true;
  }
  if (started) out.push(buf);
  return out;
}

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
  return base.toLowerCase().replace(/\.(?:exe|com|bat|cmd|ps1|sh)$/, '');
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
function wipeProgramIn(statement) {
  const tokens = tokenize(statement).filter((t) => t.length > 0);
  // Four tokens is enough for `cmd.exe /d /c shred …`; a wipe tool invoked
  // further along a launcher's line is not reachable without `&`/`.`, which the
  // statement splitter already treats as a boundary.
  for (let i = 0; i < tokens.length && i < 4; i += 1) {
    const name = programName(tokens[i]);
    if (name.length === 0) continue;
    if (WIPE_PROGRAMS.has(name)) return name;
    if (i === 0 && !LAUNCHER_VERBS.has(name)) return undefined;
  }
  return undefined;
}

/**
 * Find the command word of one statement: the token that names the thing being
 * run, with the wrapper prefixes removed the same way `parseDeleteStatement`
 * removes them (`&`, `.`, `(`, `@(`, `$x =`) and quotes stripped.
 *
 * `& "Clear-RecycleBin"` is the case that motivated this: the statement
 * splitter treats `&` as a separator, so what is left is a bare quoted name, and
 * a `^clear-recyclebin` regex over raw text never saw it.
 *
 * @param statement - one statement.
 * @returns the command word, or `''`.
 */
function commandWord(statement) {
  const tokens = tokenize(statement).filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (/^(?:[(\[{@&.]+|\$\(|=)$/.test(t)) continue;
    const glued = /^[(\[{@&]+(.+)$/.exec(t);
    if (glued !== null) return unquote(glued[1]).trim();
    if (/^\$[A-Za-z_][\w:]*$/.test(t) && tokens[i + 1] === '=') {
      i += 1;
      continue;
    }
    const assign = /^\$[A-Za-z_][\w:]*\s*=\s*(.+)$/.exec(t);
    if (assign !== null) return assign[1].trim();
    return unquote(t).trim();
  }
  return '';
}

/**
 * The body text of a statement that hands a program to a child shell:
 * `pwsh -Command "…"`, `bash -c "…"`, `node -e "…"`.
 *
 * @param statement - one statement.
 * @returns the body text, or `undefined` when the statement runs no child.
 */
function inlineBodyText(statement) {
  const tokens = tokenize(statement).filter((t) => t.length > 0);
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
  return words.filter((w) => w.length > 0);
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
 * @param command - the full command text.
 * @returns the statements decoded from every encoded body.
 */
function decodedInlineBodies(command) {
  const out = [];
  for (const m of command.matchAll(/-EncodedCommand\s+([A-Za-z0-9+/=]{8,})/gi)) {
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
    return {
      refuse:
        `Refusing a delete that targets the POSIX path "${operand}": that is a Git Bash / MSYS mount point, not a ` +
        'Windows path, so the real location cannot be proven. Resolve it first, then pass the Windows path to file_trash.',
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
 * @param statement - one statement, already split from the command.
 * @returns the matched name, or `undefined`.
 */
function wipeProgramInInlineBody(statement) {
  if (!INLINE_BODY_FLAGS.test(statement)) return undefined;
  const found = WIPE_NAME_IN_BODY.exec(statement);
  return found === null ? undefined : found[0].toLowerCase();
}

/**
 * Classify one statement as a delete we can rewrite.
 * @param statement - one statement string.
 * @returns the verb plus its operand tokens, or `undefined` when not a delete.
 */
function parseDeleteStatement(statement) {
  const tokens = tokenize(statement);
  if (tokens.length === 0) return undefined;

  const known = new Set([
    ...PS_DELETE_VERBS,
    ...PS_DELETE_ALIASES,
    ...POSIX_DELETE_VERBS,
  ]);

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
    if (i < tokens.length && known.has(tokens[i].toLowerCase())) {
      return {
        verb: tokens[i].toLowerCase(),
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

  const verb = tokens[0].toLowerCase();
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
    if (tok.startsWith('-')) {
      const flag = tok.toLowerCase();
      if (flag === '-recurse' || flag === '-r') recursive = true;
      if (flag === '-force' || flag === '-f') force = true;
      if (flag === '--no-preserve-root') preserveRoot = true;
      // A flag that takes a value is not a target: without this, `-ErrorAction
      // SilentlyContinue` made "SilentlyContinue" a path to recycle, and the
      // redirect message told the model to `file_trash` a value name. The two
      // path flags are the exception — their value *is* the target.
      const takesValue = FLAGS_TAKING_VALUE.has(flag);
      const isPathFlag = flag === '-path' || flag === '-literalpath';
      if ((takesValue || isPathFlag) && i + 1 < tokens.length) {
        if (isPathFlag) operands.push(unquote(tokens[i + 1]));
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
    operands.push(unquote(tok));
  }

  // PowerShell accepts a comma-separated operand list: `Remove-Item a, b`. The
  // tokenizer keeps the separator glued to the preceding token, so split it off
  // and treat each element as its own operand. A closing bracket glued to the
  // last operand (`(Remove-Item C:\x)`) is stripped for the same reason: it is
  // the wrapper's, not part of the path.
  const expanded = [];
  for (const operand of operands) {
    for (const piece of operand.split(',')) {
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
  const bodyStatements = decodedInlineBodies(command);
  const judged = [...statements, ...bodyStatements];

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
    // recycle. Reading the bin (Move-Item out of $R, listing $I records) stays
    // allowed — only driving its verbs is refused.
    if (BIN_NAMESPACE_REF.test(command) && BIN_VERB_DRIVE.test(command)) {
      return emptyRecycleVerdict("the Recycle Bin's own shell verbs (InvokeVerb / Verbs / DoIt)");
    }
  }

  if (forbidWipe) {
    for (const statement of judged) {
      const program = wipeProgramIn(statement) ?? wipeProgramInInlineBody(statement);
      if (program !== undefined) {
        return {
          action: 'deny',
          kind: 'wipe',
          reason: `${WIPE_REASON} ("${program}" erases the data instead of moving it.)`,
        };
      }
    }
    for (const rule of WIPE_FLAG_SHAPES) {
      if (rule.test(command)) {
        return { action: 'deny', kind: 'wipe', reason: WIPE_REASON };
      }
    }
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

    // 1. A shell's inline body that contains a shell delete verb.
    //    `pwsh -Command "Remove-Item C:\x"`, `bash -c "rm -rf /tmp/x"`.
    //    Scoped to shells: in Python or Ruby, `del` and `rm` are that
    //    language's own syntax, so they are judged by rule 2 instead.
    for (const statement of statements) {
      const shellInterp = /\b(?:bash|sh|zsh|pwsh|powershell)\b/i.test(statement);
      const inlineBody = INLINE_BODY_FLAGS.test(statement);
      if (shellInterp && inlineBody && SHELL_DELETE_VERB.test(statement)) {
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
    const otherInterp = /\b(?:node|python|python3|perl|ruby)\b/i.test(command);
    const inlineBody = INLINE_BODY_FLAGS.test(command);
    if (otherInterp && inlineBody && PROGRAMMATIC_ERASE.test(command)) {
      return {
        action: 'deny',
        kind: 'script',
        reason:
          'Deletes inside an inline program string are disabled by the recycle-bin guard: the erase happens ' +
          'inside the child process and would bypass the Recycle Bin. ' +
          'Run the delete as a direct file_trash tool call instead.',
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
      // An operand that is itself a substitution has no provable value: the
      // shell expands it at run time. `rm -rf $(cat list.txt)` would otherwise
      // be tokenized into the literal strings `$(cat` and `list.txt)`, and
      // "recycling" those would move the wrong things. This check is
      // dialect-independent — bash allows `$( … )` as syntax, but never as an
      // unexpandable delete target.
      if (SUBSTITUTION_IN_TARGET.test(operand)) {
        return {
          action: 'deny',
          kind: 'opaque',
          reason:
            'Refusing a delete whose target is a command substitution: the real path is only known at ' +
            'run time, so it cannot be proven safe to route to the Recycle Bin. ' +
            'Resolve the path first, then pass explicit literal paths to file_trash.',
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
      if (operand === '*' || operand === '*.ps1' || operand === '**') {
        return {
          action: 'deny',
          kind: 'forbidden-target',
          reason: 'Refusing a bare glob delete: the expanded target set is unknown. Pass explicit paths to file_trash.',
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

export { splitStatements, tokenize, parseDeleteStatement, unquote };
