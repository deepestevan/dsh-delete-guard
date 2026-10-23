/**
 * End-to-end test: the registered `file_trash` tool really moves files to the
 * OS Recycle Bin.
 *
 * This is a live test — it writes fixtures, calls the tool, and verifies both
 * that the path left the working directory and that Recycle Bin occupancy grew.
 *
 * Run: node --test test/e2e.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { apply } = await import('../lib/index.js');

/**
 * Load the plugin into a fake context and return the `file_trash` definition.
 * @param {object} config - plugin configuration.
 * @returns {Promise<{definition: object, ctx: object}>}
 */
async function loadTrashTool(config = {}) {
  const registered = [];
  const ctx = {
    tools: { register: (d) => (registered.push(d), () => {}) },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    logger: { warn() {} },
  };
  apply(ctx, config);
  return { definition: registered.find((t) => t.name === 'file_trash'), ctx };
}

/** A minimal ToolExecution stand-in. */
function fakeExec(overrides = {}) {
  return {
    callId: 'test-call',
    name: 'file_trash',
    arguments: {},
    signal: new AbortController().signal,
    agent: { session: { cwd: process.cwd() } },
    ...overrides,
  };
}

/** Read Recycle Bin occupancy for a drive via the plugin's own bridge. */
async function binUsage(drive) {
  const { recycleBinUsage } = await import('../lib/recycle.js');
  return recycleBinUsage(drive);
}

test('file_trash moves a file into the Recycle Bin and reports it', async () => {
  const { definition } = await loadTrashTool();

  const dir = await mkdtemp(join(tmpdir(), 'dsh-trash-e2e-'));
  const victim = join(dir, 'victim.txt');
  await writeFile(victim, 'recycle me', 'utf8');

  const drive = victim.slice(0, 2);
  const before = await binUsage(drive);

  const result = await definition.execute({ paths: [victim] }, fakeExec());

  assert.deepEqual(result.failures, [], `unexpected failures: ${JSON.stringify(result.failures)}`);
  assert.equal(result.recycled.length, 1);
  assert.equal(result.recycled[0], victim);

  // Gone from its original location...
  await assert.rejects(() => stat(victim), /ENOENT/);

  // ...and the Recycle Bin actually grew.
  const after = await binUsage(drive);
  assert.ok(
    after.items > before.items,
    `Recycle Bin item count should grow: before=${before.items} after=${after.items}`,
  );

  await rm(dir, { recursive: true, force: true });
});

test('file_trash recycles a directory tree as one unit', async () => {
  const { definition } = await loadTrashTool();

  const dir = await mkdtemp(join(tmpdir(), 'dsh-trash-e2e-dir-'));
  const tree = join(dir, 'tree');
  await mkdir(join(tree, 'nested'), { recursive: true });
  await writeFile(join(tree, 'a.txt'), 'a', 'utf8');
  await writeFile(join(tree, 'nested', 'b.txt'), 'b', 'utf8');

  const drive = tree.slice(0, 2);
  const before = await binUsage(drive);

  const result = await definition.execute({ paths: [tree] }, fakeExec());

  assert.deepEqual(result.failures, []);
  assert.equal(result.recycled.length, 1);
  await assert.rejects(() => stat(tree), /ENOENT/);

  const after = await binUsage(drive);
  assert.ok(after.items > before.items);

  await rm(dir, { recursive: true, force: true });
});

test('file_trash resolves workspace-relative paths against the session cwd', async () => {
  const { definition } = await loadTrashTool();

  const dir = await mkdtemp(join(tmpdir(), 'dsh-trash-e2e-rel-'));
  await writeFile(join(dir, 'relative.txt'), 'x', 'utf8');

  const result = await definition.execute(
    { paths: ['relative.txt'] },
    fakeExec({ agent: { session: { cwd: dir } } }),
  );

  assert.deepEqual(result.failures, []);
  assert.equal(result.recycled.length, 1);
  await assert.rejects(() => stat(join(dir, 'relative.txt')), /ENOENT/);

  await rm(dir, { recursive: true, force: true });
});

test('a missing path is reported as a failure, not a crash', async () => {
  const { definition } = await loadTrashTool();
  const result = await definition.execute(
    { paths: ['C:/definitely/not/here/xyz.txt'] },
    fakeExec(),
  );
  assert.equal(result.recycled.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /no such file/);
});

test('an empty path list is refused rather than silently succeeding', async () => {
  const { definition } = await loadTrashTool();
  const result = await definition.execute({ paths: [] }, fakeExec());
  assert.equal(result.recycled.length, 0);
  assert.equal(result.failures.length, 1);
});

test('render output tells the user the items are recoverable', async () => {
  const { definition } = await loadTrashTool();
  const value = { recycled: ['C:/tmp/gone.txt'], failures: [] };
  const blocks = definition.output.render({ paths: ['C:/tmp/gone.txt'] }, value);
  const text = blocks.map((b) => b.text).join('\n');
  assert.match(text, /Recycle Bin/);
  assert.match(text, /recoverable/);
});

test('file_trash recycles a non-ASCII path without corrupting it', async () => {
  // Regression: the bridge read stdin through [Console]::In, whose encoding is
  // the OEM code page (GBK on a zh-CN box) rather than UTF-8. A Chinese path
  // arrived at SHFileOperationW as GBK mojibake and the delete failed. The
  // fixture name must stay non-ASCII for this to guard anything.
  const { definition } = await loadTrashTool();

  const dir = await mkdtemp(join(tmpdir(), 'dsh-trash-cn-'));
  const victim = join(dir, '用户原话.md');
  await writeFile(victim, 'content', 'utf8');

  const result = await definition.execute({ paths: [victim] }, fakeExec());

  assert.deepEqual(result.failures, [], `unexpected failures: ${JSON.stringify(result.failures)}`);
  // The path round-trips byte-identical: any GBK round-trip would mangle it.
  assert.deepEqual(result.recycled, [victim]);
  await assert.rejects(() => stat(victim), /ENOENT/);

  await rm(dir, { recursive: true, force: true });
});

test('an unusable operand does not fail the rest of the batch', async () => {
  // SHFileOperationW applies its path list as a single transaction, so one bad
  // entry used to fail every path in the request. The bridge now calls it once
  // per path; each reported error belongs to the path it names.
  const { recyclePaths } = await import('../lib/recycle.js');

  const dir = await mkdtemp(join(tmpdir(), 'dsh-trash-mixed-'));
  const goodUtf8 = join(dir, '用户原话.md');
  const goodAscii = join(dir, 'ascii.txt');
  const missing = join(dir, 'not-here.md');
  await writeFile(goodUtf8, 'x', 'utf8');
  await writeFile(goodAscii, 'y', 'utf8');

  const result = await recyclePaths([goodUtf8, missing, goodAscii], {});

  assert.deepEqual(result.failures.map((f) => f.path), [missing]);
  assert.deepEqual(result.recycled, [goodUtf8, goodAscii]);
  await assert.rejects(() => stat(goodUtf8), /ENOENT/);
  await assert.rejects(() => stat(goodAscii), /ENOENT/);

  await rm(dir, { recursive: true, force: true });
});

test('a path with no Recycle Bin is refused instead of silently erased', async () => {
  // Regression, reproduced 2026-10-23: SHFileOperationW + FOF_ALLOWUNDO on a
  // UNC path does not fail — it erases the file and returns 0, and the "did the
  // path leave?" post-check cannot tell that apart from a recycle. The probe
  // file vanished from the share, no $I/$R record appeared on any local volume,
  // and SHQueryRecycleBin was unchanged, while the tool reported "Moved to the
  // Recycle Bin". The bridge now refuses up front, which costs nothing here
  // because the path never needs to exist to be judged.
  const { recyclePaths } = await import('../lib/recycle.js');

  const result = await recyclePaths(['\\\\server\\share\\doomed.txt'], {});

  assert.deepEqual(result.recycled, []);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /no Recycle Bin/);
  assert.match(result.failures[0].error, /permanently/);
});

test('a local NTFS path still recycles (the refusal must not be a blanket block)', async () => {
  const { recyclePaths } = await import('../lib/recycle.js');

  const dir = await mkdtemp(join(tmpdir(), 'dsh-trash-ntfs-'));
  const victim = join(dir, 'keep-me-recyclable.txt');
  await writeFile(victim, 'x', 'utf8');

  const result = await recyclePaths([victim], {});

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.recycled, [victim]);
  await assert.rejects(() => stat(victim), /ENOENT/);

  await rm(dir, { recursive: true, force: true });
});
