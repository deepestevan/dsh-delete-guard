/**
 * Operand guard for the `file_trash` tool path.
 *
 * `guard.js` polices the *shell* side: a delete command the model tries to run
 * through pwsh/bash is denied and redirected here. This module polices the
 * landing side — the model calling `file_trash` directly, which no shell
 * interception sees.
 *
 * Both reach the Recycle Bin, so a bare "recycling is recoverable" argument
 * would make this redundant. It is not: the Windows Recycle Bin is *not*
 * exempt from the paths below. Recycle Bin storage lives on the same volume
 * it serves, so recycling `C:\` moves the contents of `C:\$Recycle.Bin` into
 * `C:\$Recycle.Bin` — undefined behaviour at best, and the OS may simply
 * complete the erase. A drive root, the Windows directory, and a reparse
 * point to a parent all fall in that class.
 *
 * Pure: no I/O, no ctx, directly unit-testable.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';
import { translatePosixPath } from './guard.js';

/**
 * Recycle Bin storage directory at the root of any volume.
 *
 * Judged *after* stripping the drive prefix rather than with one anchored
 * pattern: `resolve()` yields `C:\$Recycle.Bin`, so a rule anchored on a
 * leading separator would only ever match `\`-relative text and silently pass
 * every absolute path. The ancestor form `C:\RECYCLER` (pre-Vista, still
 * present on some volumes) is refused for the same reason.
 *
 * @param p - a normalized absolute path.
 * @returns whether the path names that directory or sits inside it.
 */
function isRecycleBinStorage(p) {
  const driveLess = /^[a-z]:/i.test(p) ? p.slice(2) : p;
  return /^[\\/]+(?:\$recycle\.bin|recycler)(?:[\\/]|$)/i.test(driveLess);
}

/**
 * Paths the filesystem itself treats as roots, where recycling is meaningless
 * or actively destructive to the bin's own store.
 * @param p - a normalized absolute path.
 * @returns the refusal reason, or `undefined` when the path is acceptable.
 */
function forbiddenReason(p) {
  if (/^[a-z]:[\\/]?$/i.test(p)) return 'a drive root';
  if (/^[\\/]+$/.test(p)) return 'the filesystem root';
  if (/^[a-z]:[\\/]windows(?:[\\/]|$)/i.test(p)) return 'the Windows directory';
  if (/^[a-z]:[\\/]program files(?: \(x86\))?(?:[\\/]|$)/i.test(p)) return 'Program Files';
  if (isRecycleBinStorage(p)) return 'the Recycle Bin storage directory itself';
  // A share root (`\\host\share`) is the network equivalent of a drive root: it is
  // not an item, and staging it would copy (and then delete) everything on the
  // share. `\\host` alone is not even a location.
  const unc = /^[\\/]{2}([^\\/]+)(?:[\\/]([^\\/]+))?[\\/]?$/.exec(p);
  if (unc !== null) return unc[2] === undefined ? 'a network host, not a path' : 'a network share root';
  return undefined;
}

/**
 * Map a Win32 device/extended-length spelling onto the ordinary path it denotes.
 *
 * `\\?\C:\x` names the same file as `C:\x`, but every comparison in this module
 * (drive root, Windows, Program Files, the bin store, `relative()` against the
 * workspace root) is a string test — so the prefixed spelling passed all of them
 * and the bridge, which drops the prefix before calling `SHFileOperationW`, then
 * recycled the real path. Measured 2026-11-26: `file_trash(["\\?\…\a.txt"])`
 * moved the file into the bin and `\\?\C:\Windows\System32\kernel32.dll` passed
 * every check.
 *
 * Normalizing here, once, is the fix: the root checks, the workspace comparison,
 * `isNetworkPath` and the bridge all see the same string afterwards.
 *
 * Two device spellings are refused rather than resolved. `\\?\Volume{GUID}\…` and
 * `\\?\GLOBALROOT\…` do not contain a drive letter, so dropping the prefix turns
 * them into a *relative* path; the bridge's `GetFullPath` then resolves them
 * against the plugin process's directory and recycles whatever shares that name.
 *
 * @param text - the operand as written.
 * @returns `{ path }` with the ordinary spelling, or `{ refuse }` with the reason.
 */
function normalizeDevicePath(text) {
  // `\\?\UNC\host\share\x` is the extended spelling of `\\host\share\x`.
  if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(text)) return { path: `\\\\${text.slice(8)}` };
  // `\\?\C:\x` / `\\?\C:` — the ordinary local path with the prefix removed.
  // A bare `\\?\C:` names the drive, so it becomes the root: left as `C:` it would
  // resolve as a drive-*relative* path (the current directory on C:).
  if (/^[\\/]{2}\?[\\/][A-Za-z]:/.test(text)) {
    const rest = text.slice(4);
    return { path: /^[A-Za-z]:$/.test(rest) ? `${rest}\\` : rest };
  }
  if (/^[\\/]{2}\?[\\/]/.test(text)) {
    return {
      refuse: `refusing "${text}": that is an extended-length device path (\`\\?\` without a drive letter), `
        + 'not a file path this tool can resolve. Pass the ordinary path (`C:\\…`) instead.',
    };
  }
  // `\\.\C:\x`, `\\.\PhysicalDrive0`: device namespace, not an item.
  if (/^[\\/]{2}\.[\\/]/.test(text)) {
    return {
      refuse: `refusing "${text}": that is a device path (\`\\.\`), not a file this tool can recycle. `
        + 'Pass the ordinary path instead.',
    };
  }
  return { path: text };
}

/**
 * Resolve and validate one model-supplied trash target.
 *
 * `..` segments are resolved rather than rejected: the resulting path is what
 * the guard judges, so `..\..` cannot smuggle an operand past the root checks.
 * A `..` that escapes the volume root collapses onto the root itself, which the
 * drive-root rule then catches.
 *
 * @param raw - the path as written by the model.
 * @param cwd - the session working directory, used for relative operands.
 * @returns `{ ok: true, path }` with an absolute path, or `{ ok: false, error }`.
 */
export function validateTrashTarget(raw, cwd) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return { ok: false, error: 'empty path' };

  const normalized = normalizeDevicePath(text);
  if (normalized.refuse !== undefined) return { ok: false, error: normalized.refuse };

  // The same translation the classifier applies to a Git Bash command, applied to a
  // direct `file_trash` operand.
  //
  // Without it the two entry points disagreed: measured 2026-11-24, `rm
  // /c/Users/Deepe/x` was redirected to `C:\Users\Deepe\x`, while
  // `file_trash("/c/Users/Deepe/x")` resolved to `<plugin process drive>:\c\Users\…`
  // — a different file on a different drive, silently. The system prompt claimed the
  // translation happened here, and it did not.
  //
  // Reusing one function rather than a second copy is the point: the string means the
  // same thing wherever it enters, so the two paths cannot drift apart again.
  const mapped = translatePosixPath(normalized.path);
  if (mapped.refuse !== undefined) return { ok: false, error: mapped.refuse };
  const candidate = mapped.path;

  let absolute;
  try {
    absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd ?? process.cwd(), candidate);
  } catch (error) {
    return { ok: false, error: `unresolvable path: ${error.message}` };
  }

  // `\\host` (a host with no share) is not a path: `resolve` reads it as a
  // drive-relative path and yields `<cwd drive>:\host` — a *local* file that has
  // nothing to do with the share the caller meant. Refuse the shape instead of
  // recycling something else (measured: `resolve('\\\\host')` → `F:\host`).
  if (/^[\\/]{2}[^\\/]/.test(candidate) && !/^[\\/]{2}/.test(absolute)) {
    return {
      ok: false,
      error: `refusing "${text}": that names a network host but no share, so it is not a path. `
        + 'Use the full `\\\\host\\share\\...` form.',
    };
  }

  const reason = forbiddenReason(absolute);
  if (reason !== undefined) {
    return { ok: false, error: `refusing to recycle ${reason}: "${absolute}"` };
  }

  return { ok: true, path: absolute };
}

/**
 * Whether `child` sits strictly beneath `parent`.
 * @param child - the candidate descendant.
 * @param parent - the candidate ancestor.
 * @returns whether `child` is inside `parent` and is not `parent` itself.
 */
function isStrictlyWithin(child, parent) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/**
 * Reject an attempt to recycle the session workspace root or one of its
 * ancestors: that removes the directory the session is operating in, and no
 * later turn can restore its own working context from the bin alone.
 *
 * Deliberately narrow. Deleting *inside* the workspace is the ordinary case and
 * stays allowed — an earlier revision rejected anything under the root, which
 * would have made the tool useless rather than safe.
 *
 * A missing `workspaceRoot` disables this half only; the root rules in
 * {@link validateTrashTarget} are unconditional.
 *
 * @param target - an absolute path already accepted by {@link validateTrashTarget}.
 * @param workspaceRoot - the sandbox policy's workspace root, when one resolved.
 * @returns the refusal reason, or `undefined` when the target is acceptable.
 */
export function workspaceRootReason(target, workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) return undefined;

  let root;
  try {
    root = resolve(workspaceRoot);
  } catch {
    return undefined;
  }

  if (target === root) return `refusing to recycle the session workspace root itself: "${target}"`;
  if (isStrictlyWithin(root, target)) {
    return `refusing to recycle a parent of the session workspace: "${target}"`;
  }
  return undefined;
}
