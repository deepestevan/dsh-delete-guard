/**
 * Shell-text lexing, shared by the delete guard and the overwrite guard.
 *
 * These four helpers are the only part of the matcher that is genuinely about
 * *text* rather than about a rule: splitting a command into statements, turning a
 * statement into argv-like words, unwrapping quotes, and finding the word that
 * names what a statement runs. They live here rather than in `guard.js` because
 * two rule modules now need them — and because a rule module that imports the
 * rule module beside it (guard.js → rewrite-guard.js → guard.js) is a cycle, not
 * an architecture.
 *
 * Everything here is pure and dialect-agnostic on purpose: the differences that
 * matter (PowerShell's `$( … )` opacity, MSYS path translation) belong to the
 * rules, not to the lexer.
 */

/**
 * Strip a single layer of shell quote characters.
 * @param token - raw operand token.
 * @returns the token without surrounding quotes.
 */
export function unquote(token) {
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
export function splitStatements(command) {
  return splitStatementsDetailed(command).map((entry) => entry.text);
}

/**
 * Split a command into statements **and say how deeply each one is nested in braces**.
 *
 * The overwrite guard needs the nesting to answer one question: are this file's write and
 * this file's read inside the *same* loop body? Textual order is unreliable there, but only
 * inside the body that repeats — a loop earlier in the command says nothing about a write
 * and a read that both happen after it. Measured 2026-11-26: a command that iterated over
 * files, then wrote a temp file, then read it back for verification, was refused as an
 * in-place rewrite because *some* loop existed.
 *
 * The depth is the brace depth at the statement's first character: a statement starting the
 * body of `foreach (…) { … }` is at depth 1, and the statement after the closing brace is
 * back at 0.
 *
 * @param command - full command text.
 * @returns `[{ text, depth }]`, in order.
 */
export function splitStatementsDetailed(command) {
  const out = [];
  let buf = '';
  let quote = null;
  let depth = 0;
  const flush = () => {
    if (buf.trim().length > 0) out.push({ text: buf.trim(), depth });
    buf = '';
  };
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
      flush();
      if (ch === '{') depth += 1;
      if (ch === '}') depth = Math.max(0, depth - 1);
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

/**
 * Tokenize a single statement into argv-like words, honouring quotes, and say which
 * words were written inside quotes.
 *
 * The quoting has to survive the scan because it changes what a comma means:
 * `Remove-Item "[a,b].txt"` names one file whose name contains a comma, while
 * `Remove-Item a.txt, b.txt` names two files. Both arrive at the parser as the text
 * `[a,b].txt` and `a.txt,`, so a parser that splits on every comma turns the first into
 * two paths — and the refusal then tells the caller to recycle `[a` and `b].txt`.
 * Measured 2026-11-25.
 *
 * @param statement - one statement.
 * @returns one entry per token, in order.
 */
export function tokenizeSegments(statement) {
  const out = [];
  let buf = '';
  let quote = null;
  let started = false;
  let quoted = false;
  for (let i = 0; i < statement.length; i += 1) {
    const ch = statement[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        buf += ch;
      }
      started = true;
      quoted = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      quoted = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        out.push({ text: buf, quoted });
        buf = '';
        started = false;
        quoted = false;
      }
      continue;
    }
    buf += ch;
    started = true;
  }
  if (started) out.push({ text: buf, quoted });
  return out;
}

/**
 * Tokenize a single statement into argv-like words, honouring quotes.
 * @param statement - one statement.
 * @returns the token list.
 */
export function tokenize(statement) {
  return tokenizeSegments(statement).map((segment) => segment.text);
}

/**
 * Blank out bash here-document bodies, so a message or a file being written is not read as
 * commands.
 *
 * `git commit -F - <<'MSG' … MSG` hands the body to git as text, but `splitStatements` knows
 * nothing about here-docs: it split the body into statements, and a commit message quoting
 * `Set-Content f` and `$lines[0..($idx-2)]` became a write plus a slice (measured 2026-11-26,
 * on this repository's own commit message). The body is replaced with spaces, newlines kept,
 * so every index still points at the same place.
 *
 * A here-doc **handed to an interpreter** (`python <<'EOF'`) is the program, not data, and is
 * left alone — the same rule `maskHereStrings` uses.
 *
 * @param command - the raw command text.
 * @returns the same text with data-only here-doc bodies blanked.
 */
export function maskHereDocs(command) {
  const MARKER = /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/g;
  let out = command;
  let match;
  while ((match = MARKER.exec(command)) !== null) {
    const start = match.index + match[0].length;
    const before = command.slice(Math.max(0, match.index - 48), match.index);
    // The word before the marker decides: an interpreter runs the body.
    if (/(?:^|[\s;|&(])(?:python3?|node|bash|sh|zsh|pwsh|powershell|perl|ruby|iex)\b[^\n]*$/i.test(before)) continue;
    const closer = new RegExp(`^[ \\t]*${match[2]}[ \\t]*$`, 'm');
    const rest = command.slice(start);
    const end = closer.exec(rest);
    const bodyEnd = end === null ? command.length : start + end.index;
    if (bodyEnd <= start) continue;
    out = out.slice(0, start) + out.slice(start, bodyEnd).replace(/[^\n]/g, ' ') + out.slice(bodyEnd);
  }
  return out;
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
export function commandWord(statement) {
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
 * The tokens of one statement with the same wrapper prefixes removed that
 * `commandWord` steps over: leading `(`, `$(`, `@(`, `&`, `.`, `=` tokens, a
 * wrapper glued to the first word, and a `$name =` assignment.
 *
 * Rules that need the *operand list* rather than just the command word (the
 * overwrite guard asks "which file is this writing?") cannot re-derive it from
 * `commandWord`'s return value, which drops everything after the first word.
 *
 * @param statement - one statement.
 * @returns the remaining tokens, first one being the command word.
 */
export function statementTokens(statement) {
  const tokens = tokenize(statement).filter((t) => t.length > 0);
  for (let guard = 0; guard < tokens.length; guard += 1) {
    const t = tokens[0];
    if (/^(?:[(\[{@&.]+|\$\(|=)$/.test(t)) {
      tokens.shift();
      continue;
    }
    const glued = /^[(\[{@&]+(.+)$/.exec(t);
    if (glued !== null) {
      tokens[0] = glued[1];
      continue;
    }
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
  return tokens;
}

/**
 * Blank out here-string bodies that are plainly data, so a later scan does not read
 * documentation as code.
 *
 * `@'…'@` and `@"…"@` are string literals. `splitStatements` already treats the pair as one
 * quoted run, so statement parsing never saw a delete inside — but the scans for
 * `[scriptblock]::Create(…)`, inline shell bodies and `fs.readFileSync` / `writeFileSync`
 * match raw text, so a here-string that *quotes* such a call was read as making the call.
 * Measured 2026-11-25: a release note listing `& ([scriptblock]::Create("Remove-Item …"))`
 * as an illustration was refused as a delete.
 *
 * Only a here-string that is **handed to an interpreter** is left alone: `-c @'…'@`,
 * `-Command @'…'@`, `[scriptblock]::Create(@'…'@)`. There the body *is* the program, and
 * blanking it would hide `shutil.rmtree(…)` from the rule that exists to catch it. Every
 * other here-string is a value — assigned, piped, or standing alone as an expression — and
 * nothing in it runs.
 *
 * A here-string that is later executed (`$b = @'…'@; iex $b`, or `@'…'@ | iex`) stays caught:
 * a bare `iex` takes its text from the pipe.
 *
 * The body becomes spaces with its newlines kept, so every later index still points at the
 * same place. Lives here rather than in `guard.js` because both the classifier and the
 * overwrite guard need it, and neither should import the other.
 *
 * @param command - the raw command text.
 * @returns the same text with the data-only here-string bodies blanked.
 */
export function maskHereStrings(command) {
  const HERE = /@(['"])[\r\n]+[\s\S]*?[\r\n]+\1@/g;
  return command.replace(HERE, (block, _quote, offset) => {
    // What precedes the opening `@'` decides whether the body is a program.
    const before = command.slice(Math.max(0, offset - 32), offset);
    if (/(?:^|[\s;|&(])(?:-c|-e|-command|-encodedcommand|--eval|--execute)\s+$/i.test(before)) return block;
    if (/[C]reate\s*\(\s*$/i.test(before)) return block;
    return block.replace(/[^\n]/g, ' ');
  });
}
