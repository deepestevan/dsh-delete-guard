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
  return undefined;
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

  let absolute;
  try {
    absolute = isAbsolute(text) ? resolve(text) : resolve(cwd ?? process.cwd(), text);
  } catch (error) {
    return { ok: false, error: `unresolvable path: ${error.message}` };
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
