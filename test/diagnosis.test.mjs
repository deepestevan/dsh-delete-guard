/**
 * End-to-end tests for the two failures that used to arrive as a message pointing at
 * the wrong thing.
 *
 * Measured 2026-11-24 on this machine:
 *
 *   - a directory containing a child whose name ends with a space or a dot cannot be
 *     recycled: SHFileOperationW returns 0x2 (DE_FILENOTFOUND) and the old message
 *     said "the path no longer exists" while the path was right there;
 *   - a directory held as some process's working directory returns 0x20
 *     (DE_ACCESSDENIED).
 *
 * The fix is diagnosis, not capability: the message names the offending entries, or
 * says what "access denied" means for a directory and how to find the holder. What it
 * must NOT do is narrate the tool's own restraint — the caller reads the reply to find
 * its next action, not to audit the tool. The tests assert the useful content and the
 * absence of that self-description, plus that nothing is deleted or renamed on the
 * user's behalf.
 *
 * Windows-only: the whole bridge is SHFileOperationW.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const { apply } = await import('../lib/index.js');

const WINDOWS = process.platform === 'win32';

/**
 * Load the plugin into a fake context and return the `file_trash` definition.
 * @param {object} config - plugin configuration.
 * @returns {{definition: object}}
 */
function loadTrashTool(config = {}) {
  const registered = [];
  apply({
    tools: { register: (d) => (registered.push(d), () => {}) },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    logger: { warn() {} },
  }, config);
  return { definition: registered.find((t) => t.name === 'file_trash') };
}

/** A minimal ToolExecution stand-in. */
function fakeExec() {
  return {
    callId: 'test-call',
    name: 'file_trash',
    arguments: {},
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: process.cwd() } } },
  };
}

/**
 * The literal-path prefix, built from character codes.
 *
 * Written this way on purpose: a plain string literal goes through several layers of
 * quoting on its way to these tests, and a miscounted backslash silently becomes a
 * different path (`\\\\?\\C:` is not `\\?\C:`). Building it from code points makes
 * the value self-evident.
 */
const BACKSLASH = String.fromCharCode(92);
const LITERAL_PREFIX = `${BACKSLASH}${BACKSLASH}?${BACKSLASH}`;

/**
 * Create a name Win32 cannot address: the literal prefix is the only way to create
 * one, since a normal path trims the trailing character.
 *
 * @param dir - the directory to create it in.
 * @param name - a name ending with a space or a dot.
 */
async function createUnaddressable(dir, name) {
  await writeFile(LITERAL_PREFIX + join(dir, name), 'x', 'utf8');
}

test('a directory whose child name Win32 cannot open is diagnosed, not misreported', { skip: !WINDOWS }, async () => {
  const { definition } = loadTrashTool();
  const dir = await mkdtemp(join(tmpdir(), 'dsh-diag-space-'));
  await writeFile(join(dir, 'normal.txt'), 'n', 'utf8');
  await createUnaddressable(dir, 'trailing-space ');

  const result = await definition.execute({ paths: [dir] }, fakeExec());

  assert.equal(result.failures.length, 1);
  const message = result.failures[0].error;

  // The old wording was a lie about the path; the new one says what was not found.
  assert.doesNotMatch(message, /no longer exists/i);
  assert.match(message, /cannot open by name/i);
  // It has to name the offending entry, otherwise the caller has to search for it.
  assert.match(message, /trailing-space/);
  assert.match(message, /ends with a space/i);
  // The next action, not a statement about what this tool declines to do.
  assert.match(message, /renaming those entries/i);
  assert.doesNotMatch(message, /this tool does not/i);

  // Nothing was touched: the malformed child is still there, and so is the directory.
  const names = await readdir(LITERAL_PREFIX + dir);
  assert.ok(names.includes('normal.txt'));
  await rm(dir, { recursive: true, force: true });
});

test('a trailing dot is diagnosed the same way', { skip: !WINDOWS }, async () => {
  const { definition } = loadTrashTool();
  const dir = await mkdtemp(join(tmpdir(), 'dsh-diag-dot-'));
  await writeFile(join(dir, 'normal.txt'), 'n', 'utf8');
  await createUnaddressable(dir, 'trailing-dot.');

  const result = await definition.execute({ paths: [dir] }, fakeExec());
  const message = result.failures[0].error;

  assert.match(message, /cannot open by name/i);
  assert.match(message, /ends with a dot/i);

  await rm(dir, { recursive: true, force: true });
});

test('access denied on a directory names the likely holder and how to find it', { skip: !WINDOWS }, async () => {
  const { definition } = loadTrashTool();
  const dir = await mkdtemp(join(tmpdir(), 'dsh-diag-cwd-'));
  await writeFile(join(dir, 'inside.txt'), 'i', 'utf8');

  // Hold the directory as a working directory: this is the shape the plugin cannot
  // delete, and the one a Python environment or a build produces.
  const holder = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 20'], {
    cwd: dir,
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise((r) => setTimeout(r, 1500));

  try {
    const result = await definition.execute({ paths: [dir] }, fakeExec());
    assert.equal(result.failures.length, 1);
    const message = result.failures[0].error;

    assert.match(message, /access is denied/i);
    // Says what a directory-level denial means and that it clears when the holder exits.
    assert.match(message, /working directory|holds one of the files/i);
    assert.match(message, /once .* process exits|retry later/i);
    // And offers a way to find the holder rather than a disclaimer about the tool.
    assert.match(message, /look for a process started in this directory/i);
    assert.doesNotMatch(message, /will not guess|does not enumerate/i);
    // It must not send the caller to delete a directory's contents one by one: that
    // never removes the directory, which is what was asked for.
    assert.doesNotMatch(message, /individually/i);

    // The directory really is still there.
    assert.deepEqual(await readdir(dir), ['inside.txt']);
  } finally {
    holder.kill();
    await new Promise((r) => setTimeout(r, 500));
  }

  await rm(dir, { recursive: true, force: true });
});

test('an ordinary directory still recycles after the diagnosis work', { skip: !WINDOWS }, async () => {
  const { definition } = loadTrashTool();
  const dir = await mkdtemp(join(tmpdir(), 'dsh-diag-plain-'));
  await writeFile(join(dir, 'a.txt'), 'a', 'utf8');
  await writeFile(join(dir, 'b.txt'), 'b', 'utf8');

  const result = await definition.execute({ paths: [dir] }, fakeExec());
  assert.equal(result.failures.length, 0);
  assert.equal(result.recycled.length, 1);
});

test('a literal-prefixed local path is stripped, not called a network share', { skip: !WINDOWS }, async () => {
  const { definition } = loadTrashTool();
  const dir = await mkdtemp(join(tmpdir(), 'dsh-diag-prefix-'));
  const victim = join(dir, 'file.txt');
  await writeFile(victim, 'x', 'utf8');

  // Before the fix this matched the `\\*` network rule and was refused with
  // "a network location has no Recycle Bin" — for a file on the local NTFS volume.
  const result = await definition.execute({ paths: [LITERAL_PREFIX + victim] }, fakeExec());

  assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
  assert.equal(result.recycled.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('the diagnosis never runs on a path that is genuinely absent', { skip: !WINDOWS }, async () => {
  const { definition } = loadTrashTool();
  const dir = await mkdtemp(join(tmpdir(), 'dsh-diag-gone-'));
  const missing = join(dir, 'not-here.txt');

  const result = await definition.execute({ paths: [missing] }, fakeExec());
  assert.equal(result.failures.length, 1);
  // No misleading "contains entries" text for something that does not exist.
  assert.doesNotMatch(result.failures[0].error, /contains entries Windows cannot open/i);

  await rm(dir, { recursive: true, force: true });
});

test('a share spelled with the \\\\?\\UNC\\ prefix is still treated as a share', { skip: !WINDOWS }, async () => {
  const { definition } = loadTrashTool({ uncRecoverableMove: false });
  const dir = await mkdtemp(join(tmpdir(), 'dsh-diag-unc-'));
  const victim = join(dir, 'x.txt');
  await writeFile(victim, 'x', 'utf8');

  // `\\?\UNC\host\share\x` is the explicit spelling of `\\host\share\x`. It must not
  // be mistaken for a local path (which would send it to the local-volume rules and
  // recycle something that lives on a share).
  const uncPrefixed = `${BACKSLASH}${BACKSLASH}?${BACKSLASH}UNC${BACKSLASH}localhost${BACKSLASH}C$${BACKSLASH}no-such-dir`;
  const result = await definition.execute({ paths: [uncPrefixed] }, fakeExec());

  assert.equal(result.recycled.length, 0);
  assert.equal(result.staged.length, 0);
  assert.ok(result.failures.length >= 1);

  await rm(dir, { recursive: true, force: true });
});
