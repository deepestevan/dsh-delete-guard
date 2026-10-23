/**
 * Operand guard tests for the `file_trash` tool path.
 *
 * The shell-side guard has its own corpus in `guard.test.mjs`. This file covers
 * the landing side: what happens when the model calls `file_trash` directly,
 * with no command text for the shell rules to scan.
 *
 * Run: node --test test/move-guard.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateTrashTarget, workspaceRootReason } from '../lib/move-guard.js';
import { apply } from '../lib/index.js';

const CWD = 'D:\\Projects\\demo';

/** Load the plugin into a fake context and return the `file_trash` definition. */
async function loadTrashTool(config = {}, sandboxPolicy) {
  const registered = [];
  const ctx = {
    tools: { register: (d) => (registered.push(d), () => {}) },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    logger: { warn() {} },
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
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
    agent: { session: { cwd: CWD } },
    ...overrides,
  };
}

test('drive roots and filesystem roots are refused', () => {
  for (const p of ['C:\\', 'D:/', 'D:\\', '\\', '/']) {
    const verdict = validateTrashTarget(p, CWD);
    assert.equal(verdict.ok, false, `${p} must be refused`);
    assert.match(verdict.error, /refusing to recycle/);
  }
});

test('the Windows directory and Program Files are refused', () => {
  const refused = [
    'C:\\Windows',
    'C:\\windows\\System32',
    'D:\\Program Files',
    'C:\\Program Files (x86)\\Common Files',
  ];
  for (const p of refused) {
    assert.equal(validateTrashTarget(p, CWD).ok, false, `${p} must be refused`);
  }
});

test('a path that merely starts with the same letters is not refused', () => {
  // "WindowsApps" is not "Windows"; a prefix match without a separator would
  // wrongly reject it.
  assert.equal(validateTrashTarget('C:\\WindowsApps\\thing.txt', CWD).ok, true);
  assert.equal(validateTrashTarget('C:\\Program Files Backups\\a.txt', CWD).ok, true);
});

test('the Recycle Bin storage directory is refused', () => {
  const refused = [
    'C:\\$Recycle.Bin',
    'D:\\$Recycle.Bin\\S-1-5-21-1',
    'C:\\$recycle.bin\\x',
    // Pre-Vista store, still present on some volumes.
    'C:\\RECYCLER\\x',
  ];
  for (const p of refused) {
    assert.equal(validateTrashTarget(p, CWD).ok, false, `${p} must be refused`);
    assert.match(validateTrashTarget(p, CWD).error, /Recycle Bin storage/);
  }
});

test('`..` segments are resolved rather than rejected', () => {
  // An ordinary sibling reference resolves to a real path and stays allowed...
  const sibling = validateTrashTarget('..\\dsh-plugin-dev\\x.txt', CWD);
  assert.equal(sibling.ok, true);
  assert.equal(sibling.path, 'D:\\Projects\\dsh-plugin-dev\\x.txt');

  // ...while one that escapes the volume collapses onto the root and is caught.
  const escaping = validateTrashTarget('..\\..\\..\\..\\..\\', CWD);
  assert.equal(escaping.ok, false);
  assert.match(escaping.error, /drive root/);
});

test('workspace-relative and absolute ordinary paths are accepted', () => {
  const rel = validateTrashTarget('build\\out.txt', CWD);
  assert.equal(rel.ok, true);
  assert.equal(rel.path, 'D:\\Projects\\demo\\build\\out.txt');

  const abs = validateTrashTarget('D:\\tmp\\a.txt', CWD);
  assert.equal(abs.ok, true);
  assert.equal(abs.path, 'D:\\tmp\\a.txt');
});

test('an empty or non-string operand is refused with a reason', () => {
  assert.equal(validateTrashTarget('', CWD).ok, false);
  assert.equal(validateTrashTarget('   ', CWD).ok, false);
  assert.equal(validateTrashTarget(undefined, CWD).ok, false);
});

test('the workspace root and its ancestors are refused', () => {
  const root = 'D:\\Projects\\demo';

  assert.equal(
    workspaceRootReason('D:\\Projects\\demo', root),
    'refusing to recycle the session workspace root itself: "D:\\Projects\\demo"',
  );
  // The whole drive is a parent of the workspace, so the ancestor half catches it.
  assert.equal(
    workspaceRootReason('D:\\', root),
    'refusing to recycle a parent of the session workspace: "D:\\"',
  );
});

test('deleting inside the workspace stays allowed', () => {
  // The guard must not turn "safe" into "useless": every ordinary delete in a
  // session happens under the workspace root, and an earlier revision of this
  // rule rejected all of it.
  const root = 'D:\\Projects\\demo';

  assert.equal(workspaceRootReason('D:\\Projects\\demo\\sub', root), undefined);
  assert.equal(workspaceRootReason('D:\\Projects\\demo\\sub\\x.txt', root), undefined);
  assert.equal(validateTrashTarget('D:\\Projects\\demo\\sub\\x.txt', root).ok, true);
});

test('a sibling of the workspace that merely shares a prefix is allowed', () => {
  // "D:\Projects\demo-archive" is not inside "D:\Projects\demo", and "D:\Proj" is not an
  // ancestor of it — both are siblings. A string-prefix check would wrongly
  // refuse them in one direction and miss them in the other.
  const root = 'D:\\Projects\\demo';
  assert.equal(workspaceRootReason('D:\\Projects\\demo-archive\\x.txt', root), undefined);
  assert.equal(workspaceRootReason('D:\\Proj', root), undefined);
});

test('a missing workspace root disables only the workspace half', () => {
  // With no policy the plugin falls back to process.cwd(); passing none here
  // means the comparison is simply skipped, and the root rules still apply.
  assert.equal(workspaceRootReason('C:\\', undefined), undefined);
  assert.equal(validateTrashTarget('C:\\', CWD).ok, false);
});

test('file_trash reports a refused root as a per-path failure, not a crash', async () => {
  // Two different refusals in one call: a filesystem root from the unconditional
  // rules, and the workspace root from the policy-reported comparison. The
  // policy is stated explicitly so the assertion does not depend on where the
  // test process happens to be running.
  const { definition } = await loadTrashTool({}, {
    resolve: () => ({ workspaceRoot: 'D:\\Projects\\demo', mode: 'danger-full-access' }),
  });

  const result = await definition.execute({ paths: ['C:\\', 'D:\\Projects\\demo'] }, fakeExec());

  assert.deepEqual(result.recycled, []);
  assert.equal(result.failures.length, 2, JSON.stringify(result.failures));
  assert.match(result.failures[0].error, /refusing to recycle a drive root/);
  assert.match(result.failures[1].error, /session workspace root/);
});

test('file_trash resolves the workspace root from the sandbox policy', async () => {
  const { definition } = await loadTrashTool({}, {
    resolve: () => ({ workspaceRoot: 'D:\\Projects\\demo', mode: 'danger-full-access' }),
  });

  const result = await definition.execute({ paths: ['D:\\Projects\\demo'] }, fakeExec());
  assert.equal(result.recycled.length, 0);
  assert.match(result.failures[0].error, /session workspace root/);
});

test('file_trash still recycles a normal path under a policy-reported root', async () => {
  const { mkdtemp, writeFile, stat, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'dsh-move-guard-'));
  const victim = join(dir, 'victim.txt');
  await writeFile(victim, 'recycle me', 'utf8');

  const { definition } = await loadTrashTool({}, {
    resolve: () => ({ workspaceRoot: dir, mode: 'danger-full-access' }),
  });

  const result = await definition.execute({ paths: [victim] }, fakeExec());
  assert.deepEqual(result.failures, [], JSON.stringify(result.failures));
  assert.deepEqual(result.recycled, [victim]);
  await assert.rejects(() => stat(victim), /ENOENT/);

  await rm(dir, { recursive: true, force: true });
});

test('a bad operand does not stop the good ones in the same call', async () => {
  const { definition } = await loadTrashTool();

  const result = await definition.execute(
    { paths: ['C:\\', 'D:\\definitely\\not\\here\\xyz.txt'] },
    fakeExec(),
  );

  assert.deepEqual(result.recycled, []);
  assert.equal(result.failures.length, 2, 'both operands must be reported');
  assert.match(result.failures[0].error, /refusing to recycle/);
  assert.match(result.failures[1].error, /no such file/);
});
