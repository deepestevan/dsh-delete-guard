/**
 * Deletions on volumes that have no Recycle Bin.
 *
 * The Windows Recycle Bin is a per-volume NTFS facility. On a UNC path (and on
 * exFAT/FAT32 volumes) `SHFileOperationW(FOF_ALLOWUNDO)` does not recycle: it
 * erases and returns 0, which is why `scripts/recycle-bin.ps1` refuses those
 * paths up front (reproduced 2026-10-23; see the e2e case "a path with no Recycle
 * Bin is refused").
 *
 * Refusing is safe but not useful: the deletion the user asked for never happens,
 * and the model has to invent a workaround. This module is the missing step, and
 * what it does has to be described exactly, because it is *not* a recycle:
 *
 *   1. copy the item to a staging directory on a volume that does have a bin;
 *   2. verify the copy against the original (same entries, same kinds, same sizes);
 *   3. recycle the staged copy — the item is now in the bin, restorable;
 *   4. only then remove the original, which is an ordinary permanent delete
 *      because there is no bin on that volume to hold it.
 *
 * So the guarantee is about *content*, not about the original path: after a
 * successful staging delete the bytes live in the local bin, and the item at the
 * original location is gone. Windows' own cross-volume `Move-Item` behaves the
 * same way (copy, then unlink the source), with one difference that matters: it
 * does not verify and does not leave a bin record.
 *
 * What is deliberately refused
 * ----------------------------
 * - **Reparse points** (junctions/symlinks) anywhere in the tree. A copy either
 *   dereferences them — duplicating data that is not the item — or needs
 *   privileges to recreate them. Neither is a faithful copy, so the delete stops
 *   and says so.
 * - **Not enough free space** on the staging volume, checked before copying from
 *   the measured size, so a 50 GB tree fails in a second instead of halfway.
 *
 * What is verified, and what is not
 * ---------------------------------
 * Verified: the set of relative paths, each entry's kind, and each file's size.
 * Not verified: content hashes. Hashing both sides doubles the I/O on a tree that
 * may be tens of gigabytes; sizes plus entry sets catch truncation, which is the
 * failure mode that actually destroys data. This is stated in the tool's result
 * so nobody reads more into "verified" than it means.
 *
 * The step order is the safety property: the source is removed **after** the
 * bridge confirms the staged copy is in the bin. Every earlier failure leaves the
 * original untouched.
 */

import { cp, lstat, mkdir, readdir, rm, statfs } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * Whether a path names a network location (`\\host\share\…` or `//host/share/…`).
 *
 * Matched on the prefix alone, before any I/O: the judgement must not depend on
 * the share being reachable, and a path that starts with two separators is never
 * local on Windows.
 *
 * @param p - a path as written.
 * @returns whether it is a UNC path.
 */
export function isNetworkPath(p) {
  const text = String(p ?? '');
  // `\\?\C:\…` starts with two backslashes but names a local volume. Treating it as a
  // share sent local paths down the staging branch — they were copied, verified and
  // recycled from a staging directory instead of in place (measured 2026-11-25).
  if (/^[\\/]{2}\?[\\/](?!UNC[\\/])/i.test(text)) return false;
  // `\\?\UNC\host\share\…` *is* a network path; it is spelled out instead of using the
  // `\\host\share` form. Strip the prefix so the share rules see what they expect.
  if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(text)) return true;
  return /^[\\/]{2}[^\\/]/.test(text);
}

/**
 * Whether a UNC path names the share itself (`\\host\share`) or the host alone
 * (`\\host`) rather than an item inside it. Deleting those is a
 * filesystem-root-class operation, not a file delete.
 *
 * @param p - a path as written.
 * @returns whether it is a share root (or a bare host).
 */
function isShareRoot(p) {
  const parts = String(p).slice(2).split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.length <= 2;
}

/**
 * The staging directory used when the config names none.
 * @returns an absolute path under the user's local application data.
 */
export function defaultStagingRoot() {
  const base = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local');
  return join(base, 'dsh-delete-guard', 'staging');
}

/**
 * A local timestamp for the staging directory name: readable, sortable, and the
 * only thing that identifies *when* the item left the share.
 * @param now - the clock reading.
 * @returns e.g. `20261115-002512`.
 */
function stampOf(now) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Describe a tree as relative path → { kind, size }, refusing reparse points.
 *
 * The refusal is a throw rather than a flag because every caller has to stop:
 * there is no correct continuation after "this tree cannot be copied faithfully".
 *
 * @param root - absolute path of the file or directory.
 * @param rel - the sub-path being walked.
 * @param out - accumulator.
 * @returns the map, keyed by relative path (`.` for a single file).
 * @throws when the tree contains a reparse point or cannot be read.
 */
async function walkTree(root, rel = '', out = new Map()) {
  const abs = rel === '' ? root : join(root, rel);
  const info = await lstat(abs);
  if (info.isSymbolicLink()) {
    const error = new Error(
      `it contains a reparse point (junction or symlink) at "${rel || '.'}": a copy would either duplicate `
      + 'the target\'s contents or need privileges to recreate the link, so nothing here is a faithful copy',
    );
    error.code = 'EREPARSE';
    throw error;
  }
  if (info.isDirectory()) {
    if (rel !== '') out.set(rel, { kind: 'dir' });
    const names = (await readdir(abs)).sort();
    for (const name of names) {
      await walkTree(root, rel === '' ? name : join(rel, name), out);
    }
    return out;
  }
  out.set(rel === '' ? '.' : rel, { kind: 'file', size: info.size });
  return out;
}

/**
 * Total bytes of a walked tree.
 * @param tree - the map from {@link walkTree}.
 * @returns the sum of file sizes.
 */
function totalBytes(tree) {
  let bytes = 0;
  for (const entry of tree.values()) {
    if (entry.kind === 'file') bytes += entry.size;
  }
  return bytes;
}

/**
 * Compare two walked trees and name the first difference.
 * @param original - the source tree.
 * @param copy - the staged tree.
 * @returns a human-readable difference, or `undefined` when they match.
 */
export function compareTrees(original, copy) {
  for (const [rel, entry] of original) {
    const other = copy.get(rel);
    if (other === undefined) return `"${rel}" is missing from the copy`;
    if (other.kind !== entry.kind) return `"${rel}" changed kind (${entry.kind} → ${other.kind})`;
    if (entry.kind === 'file' && other.size !== entry.size) {
      return `"${rel}" has ${other.size} bytes in the copy, ${entry.size} in the original`;
    }
  }
  for (const rel of copy.keys()) {
    if (!original.has(rel)) return `"${rel}" is in the copy but not in the original`;
  }
  return undefined;
}

/**
 * Copy → verify → recycle the copy → remove the original.
 *
 * Every step before the last can fail without touching the original, and the last
 * one only runs after the bridge has confirmed the staged copy left for the bin.
 *
 * @param source - the UNC path to delete.
 * @param options - `stagingRoot` (absolute), `recycle` (the bridge call, injected
 *   so this module stays testable and so the plugin has one recycle path),
 *   `copy` (the copy primitive, injected for the same reason), `now`.
 * @returns a result the tool can report verbatim.
 */
export async function stageForRecycle(source, options = {}) {
  const { stagingRoot = defaultStagingRoot(), recycle, copy = cp, now = new Date() } = options;
  if (typeof recycle !== 'function') throw new TypeError('stageForRecycle needs a recycle function');

  if (isNetworkPath(source) && isShareRoot(source)) {
    return { ok: false, error: 'refusing to delete a network share root itself' };
  }
  const name = basename(String(source).replace(/[\\/]+$/, ''));
  if (name.length === 0) {
    return { ok: false, error: 'refusing a path with no item name' };
  }

  let original;
  try {
    original = await walkTree(source);
  } catch (error) {
    return { ok: false, error: `cannot stage this item: ${error.message}` };
  }
  const bytes = totalBytes(original);

  try {
    await mkdir(stagingRoot, { recursive: true });
  } catch (error) {
    return { ok: false, error: `cannot create the staging directory "${stagingRoot}": ${error.message}` };
  }

  // Fail in a second rather than halfway through a copy, and say the numbers: the
  // caller has to know whether to free space, shrink the target, or pick another
  // staging volume (config `stagingRoot`).
  try {
    const space = await statfs(stagingRoot);
    const free = Number(space.bavail) * Number(space.bsize);
    if (Number.isFinite(free) && free < bytes * 1.02 + 64 * 1024 * 1024) {
      return {
        ok: false,
        error: `not enough free space on the staging volume for "${stagingRoot}": `
          + `the item is ${bytes} bytes and ${free} are available. Free space there, or point `
          + '`stagingRoot` at another local NTFS volume.',
      };
    }
  } catch {
    // No statfs support: the copy will report a real failure if space runs out.
  }

  const stageDir = join(stagingRoot, `${stampOf(now)}-${name}`);
  const dest = join(stageDir, name);

  try {
    await mkdir(stageDir);
  } catch (error) {
    return { ok: false, error: `cannot create the staging folder "${stageDir}": ${error.message}` };
  }

  try {
    await copy(source, dest, { recursive: true, preserveTimestamps: true, dereference: false });
  } catch (error) {
    return {
      ok: false,
      staged: stageDir,
      error: `copying to the local staging volume failed: ${error.message}. The original was not touched; `
        + `a partial copy may be left at "${stageDir}".`,
    };
  }

  let stagedTree;
  try {
    stagedTree = await walkTree(dest);
  } catch (error) {
    return { ok: false, staged: stageDir, error: `cannot verify the copy: ${error.message}` };
  }
  const difference = compareTrees(original, stagedTree);
  if (difference !== undefined) {
    return {
      ok: false,
      staged: stageDir,
      error: `the copy does not match the original (${difference}), so nothing was deleted. `
        + `The copy is at "${stageDir}" for inspection.`,
    };
  }
  const verification = `${original.size} entries, ${bytes} bytes`;

  // The copy is in the bin or nothing is: this is the step that turns "copied"
  // into "recoverable".
  const recycling = await recycle([stageDir]);
  if (!Array.isArray(recycling.recycled) || recycling.recycled.length !== 1) {
    const why = recycling.failures?.[0]?.error ?? 'the recycle-bin bridge did not confirm it';
    return {
      ok: false,
      staged: stageDir,
      error: `the verified copy could not be moved into the Recycle Bin (${why}), so the original was kept. `
        + `The copy is at "${stageDir}".`,
    };
  }

  try {
    await rm(source, { recursive: true, force: false, maxRetries: 1 });
  } catch (error) {
    const remaining = await walkTree(source)
      .then((tree) => [...tree.keys()].slice(0, 20))
      .catch(() => []);
    return {
      ok: true,
      staged: stageDir,
      recycled: true,
      verification,
      sourceRemoved: false,
      remaining,
      error: `the content is in the Recycle Bin, but removing the original failed: ${error.message}`,
    };
  }

  return { ok: true, staged: stageDir, recycled: true, verification, sourceRemoved: true };
}
