/**
 * Staging tests: deletions on volumes that have no Recycle Bin (UNC shares).
 *
 * The property under test is the step order, not the copy: every failure before
 * the last step must leave the original untouched, and the last step (removing the
 * original) must run only after the bridge confirms the staged copy is in the bin.
 *
 * Run: node --test test/staging.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compareTrees, defaultStagingRoot, isNetworkPath, stageForRecycle } from '../lib/staging.js';
import { validateTrashTarget } from '../lib/move-guard.js';

/** Assert a path does not exist. */
async function gone(p) {
  await assert.rejects(stat(p), (error) => error.code === 'ENOENT');
}

/**
 * A recycle stand-in that moves the item aside, so the test can prove the content
 * survived the delete. A real recycle is exercised by the e2e layer.
 */
function fakeRecycle(binDir, { fail = false } = {}) {
  return async (paths) => {
    if (fail) {
      return { recycled: [], failures: [{ path: paths[0], error: 'the bridge refused (test stand-in)' }] };
    }
    const moved = [];
    for (const p of paths) {
      const target = join(binDir, `${moved.length}-${p.split(/[\\/]/).pop()}`);
      await mkdir(target, { recursive: true });
      const { cp, rm } = await import('node:fs/promises');
      await cp(p, join(target, 'payload'), { recursive: true });
      await rm(p, { recursive: true, force: true });
      moved.push(target);
    }
    return { recycled: paths, failures: [] };
  };
}

test('network paths are recognised before any I/O', () => {
  for (const p of ['\\\\host\\share\\x.md', '//host/share/x.md', '\\\\HOST\\share']) {
    assert.equal(isNetworkPath(p), true, p);
  }
  for (const p of ['C:\\tmp\\x.md', '/c/tmp/x', 'relative\\x.md', '', '\\single']) {
    assert.equal(isNetworkPath(p), false, p);
  }
});

test('a share root is refused: it is not an item', async () => {
  // Staging `\\host\share` would copy — and then delete — everything on the share.
  const shareRoot = validateTrashTarget('\\\\host\\share', 'C:\\');
  assert.equal(shareRoot.ok, false);
  assert.match(shareRoot.error, /share root/);

  const hostOnly = validateTrashTarget('\\\\host', 'C:\\');
  assert.equal(hostOnly.ok, false);
  // Node's resolver reads `\\host` as `<cwd drive>:\host` — a local path that has
  // nothing to do with the share the caller meant, so the shape is refused rather
  // than silently redirected at a local file.
  assert.match(hostOnly.error, /network host but no share/);

  // An item inside the share is a normal target.
  const item = validateTrashTarget('\\\\host\\share\\docs\\notes.md', 'C:\\');
  assert.equal(item.ok, true);

  const staged = await stageForRecycle('\\\\host\\share', { recycle: async () => ({ recycled: [] }) });
  assert.equal(staged.ok, false);
  assert.match(staged.error, /share root/);
});

test('a directory is copied, verified, recycled, and only then removed', async () => {
  // `source` is a local temp directory here; the pipeline does not care where the
  // item lives, only `isNetworkPath` decides that. Keeping the source local makes
  // the test run without a share while exercising the same steps.
  const work = await mkdtemp(join(tmpdir(), 'dsh-stage-'));
  const source = join(work, 'notes');
  await mkdir(join(source, 'sub'), { recursive: true });
  await writeFile(join(source, 'a.md'), 'alpha', 'utf8');
  await writeFile(join(source, 'sub', 'b.md'), 'beta'.repeat(100), 'utf8');

  const stagingRoot = join(work, 'staging');
  const bin = join(work, 'bin');
  await mkdir(bin, { recursive: true });

  const result = await stageForRecycle(source, {
    stagingRoot,
    recycle: fakeRecycle(bin),
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.recycled, true);
  assert.equal(result.sourceRemoved, true);
  assert.match(result.verification, /3 entries, 405 bytes/);
  await gone(source);

  // The content is in the stand-in bin, under a staging folder whose name carries
  // the original name.
  const bins = await readdir(bin);
  assert.equal(bins.length, 1);
  assert.match(bins[0], /-notes$/);
  const copied = await readFile(join(bin, bins[0], 'payload', 'notes', 'sub', 'b.md'), 'utf8');
  assert.equal(copied, 'beta'.repeat(100));
});

test('a reparse point stops the delete instead of being copied', async () => {
  // A junction inside the tree cannot be reproduced faithfully: copying it either
  // duplicates data that is not the item or needs privileges to recreate the link.
  const work = await mkdtemp(join(tmpdir(), 'dsh-stage-junction-'));
  const target = join(work, 'elsewhere');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'keep.txt'), 'do not copy me', 'utf8');

  const source = join(work, 'tree');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'real.md'), 'x', 'utf8');
  await symlink(target, join(source, 'link'), 'junction');

  const result = await stageForRecycle(source, {
    stagingRoot: join(work, 'staging'),
    recycle: fakeRecycle(join(work, 'bin')),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /reparse point/);
  // Nothing was touched: the tree, the junction target and its content are intact.
  assert.ok((await stat(join(source, 'real.md'))).isFile());
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'do not copy me');
});

test('a failed recycle keeps the original', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dsh-stage-bin-'));
  const source = join(work, 'x.md');
  await writeFile(source, 'keep', 'utf8');

  const result = await stageForRecycle(source, {
    stagingRoot: join(work, 'staging'),
    recycle: fakeRecycle(join(work, 'bin'), { fail: true }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /could not be moved into the Recycle Bin/);
  // The whole point: the original is still there, and the verified copy is named so
  // it can be inspected or removed by hand.
  assert.equal(await readFile(source, 'utf8'), 'keep');
  assert.ok(result.staged.startsWith(join(work, 'staging')));
});

test('a copy that does not match the original is never recycled', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dsh-stage-verify-'));
  const source = join(work, 'y.md');
  await writeFile(source, 'original content', 'utf8');

  // A copy primitive that writes a *short* copy: the shape of the real failure the
  // size check exists for (a truncated write that still reports success).
  const truncatingCopy = async (_src, dst) => {
    await writeFile(dst, 'orig', 'utf8');
  };

  let recycleCalls = 0;
  const result = await stageForRecycle(source, {
    stagingRoot: join(work, 'staging'),
    copy: truncatingCopy,
    recycle: async (paths) => {
      recycleCalls += 1;
      return { recycled: paths, failures: [] };
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /does not match the original/);
  assert.match(result.error, /4 bytes in the copy, 16 in the original/);
  // The decisive assertion: the truncated copy never reached the bin, and the
  // original is untouched.
  assert.equal(recycleCalls, 0);
  assert.equal(await readFile(source, 'utf8'), 'original content');
});

test('compareTrees names the first difference', () => {
  const original = new Map([
    ['a.md', { kind: 'file', size: 10 }],
    ['sub', { kind: 'dir' }],
    ['sub/b.md', { kind: 'file', size: 20 }],
  ]);
  assert.equal(compareTrees(original, new Map(original)), undefined);

  assert.match(compareTrees(original, new Map([...original].slice(1))), /"a\.md" is missing/);

  const truncated = new Map(original);
  truncated.set('sub/b.md', { kind: 'file', size: 3 });
  assert.match(compareTrees(original, truncated), /3 bytes in the copy, 20 in the original/);

  const extra = new Map(original);
  extra.set('ghost.md', { kind: 'file', size: 1 });
  assert.match(compareTrees(original, extra), /in the copy but not in the original/);
});

test('the default staging root is a local path, not a network one', () => {
  const root = defaultStagingRoot();
  assert.equal(isNetworkPath(root), false);
  assert.match(root, /dsh-delete-guard[\\/]staging$/);
});
