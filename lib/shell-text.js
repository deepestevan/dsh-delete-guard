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
export function tokenize(statement) {
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
