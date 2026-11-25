/**
 * Layer ⑪: the same command text judged under both shells.
 *
 * Two behaviours, both measured on 2026-11-25:
 *
 * 1. `file_trash` and the command classifier had disagreed about Git Bash paths.
 *    `rm /c/Users/Deepe/x` was redirected to `C:\Users\Deepe\x`, while
 *    `file_trash('/c/Users/Deepe/x')` resolved to `<plugin cwd drive>:\c\Users\…` —
 *    a different file, silently, on the plugin process's drive. The system prompt
 *    told the model the translation happened for it. Now both calls share one
 *    translation function, so they cannot drift apart again.
 *
 * 2. A persistent terminal never says which shell it runs, and judging it as `pwsh`
 *    was not the safe default it read as: `rm /tmp/x` is `deny` under bash and
 *    `rewrite` under pwsh, while `Remove-Item $(…)` is the other way round. So the
 *    ambiguous tools are judged under both dialects and the verdicts combined.
 *
 * The negative half matters as much as the positive: a `pwsh` tool call must keep its
 * pwsh reading. If dual judging leaked onto the named shell tools, `Remove-Item
 * /tmp/x` would start being refused for users who never had a problem.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateTrashTarget } from '../lib/move-guard.js';
import { classifyCommand } from '../lib/guard.js';
import { apply } from '../lib/index.js';

const WINDOWS = process.platform === 'win32';
const CWD = 'C:\\Users\\Deepe';

/**
 * Collect the tools the plugin registers.
 * @returns the `file_trash` definition.
 */
function registeredTrash() {
  const registered = [];
  apply({
    tools: { register: (d) => (registered.push(d), () => {}) },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    logger: { warn() {} },
  }, {});
  return registered.find((t) => t.name === 'file_trash');
}

/**
 * Run the pre-execute hook the way the host does.
 * @param toolName - the tool being called.
 * @param args - its arguments.
 * @returns the hook result: `next()` yields `{ kind: 'next' }`.
 */
async function runHook(toolName, args) {
  const handlers = [];
  apply({
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    on: (event, handler) => {
      if (event === 'tools/pre-execute') handlers.push(handler);
      return () => {};
    },
    logger: { warn() {} },
  }, {});
  assert.equal(handlers.length, 1, 'expected exactly one pre-execute hook');

  let reachedNext = false;
  const result = await handlers[0]({ name: toolName, arguments: args, callId: 'test' }, async () => {
    reachedNext = true;
    return next;
  });
  return reachedNext ? next : result;
}

/** Marker for "the hook let the call through". */
const next = { kind: 'next' };

// ---------------------------------------------------------------------------
// 1. One translation for both entry points
// ---------------------------------------------------------------------------

test('a Git Bash drive path means the same thing to file_trash as to the classifier', () => {
  const command = classifyCommand('rm /c/Users/Deepe/x.txt', { dialect: 'bash' });
  assert.equal(command.action, 'rewrite');
  assert.deepEqual(command.targets, ['C:\\Users\\Deepe\\x.txt']);

  const operand = validateTrashTarget('/c/Users/Deepe/x.txt', CWD);
  assert.equal(operand.ok, true);
  assert.equal(operand.path, 'C:\\Users\\Deepe\\x.txt');
});

test('the cygdrive spelling translates the same way', () => {
  const operand = validateTrashTarget('/cygdrive/c/tmp/x.txt', CWD);
  assert.equal(operand.ok, true);
  assert.equal(operand.path, 'C:\\tmp\\x.txt');
});

test('`~` is refused, because the shell expands it to something this planner cannot see', () => {
  const operand = validateTrashTarget('~/proj', CWD);
  assert.equal(operand.ok, false);
  assert.match(operand.error, /shell expands home|`~`/i);
});

test('MSYS mount points are refused rather than read as drive-relative paths', () => {
  for (const raw of ['/tmp/x', '/usr/lib/x', '/proc/self/x']) {
    const operand = validateTrashTarget(raw, CWD);
    assert.equal(operand.ok, false, `${raw} should be refused`);
    assert.match(operand.error, /mount point/i);
  }
});

test('a network path written with forward slashes is not mistaken for a mount point', () => {
  // `//host/share` is a Windows UNC path in both shells. Applying the POSIX rules to
  // it refused a share that used to work — caught while fixing the translation above.
  for (const [raw, expected] of [
    ['//localhost/C$/x.txt', '\\\\localhost\\C$\\x.txt'],
    ['//host/share/x', '\\\\host\\share\\x'],
  ]) {
    const operand = validateTrashTarget(raw, CWD);
    assert.equal(operand.ok, true, `${raw} should reach the share handling`);
    assert.equal(operand.path, expected);
  }
});

test('a plain Windows path is untouched, and a relative path still resolves against cwd', () => {
  const absolute = validateTrashTarget('C:\\tmp\\x.txt', CWD);
  assert.equal(absolute.ok, true);
  assert.equal(absolute.path, 'C:\\tmp\\x.txt');

  for (const raw of ['sub/dir/file.txt', 'sub\\dir\\file.txt']) {
    const relative = validateTrashTarget(raw, CWD);
    assert.equal(relative.ok, true);
    assert.equal(relative.path, 'C:\\Users\\Deepe\\sub\\dir\\file.txt');
  }
});

test('the filesystem root is refused rather than mapped to a mount point', () => {
  const root = validateTrashTarget('/', CWD);
  assert.equal(root.ok, false);
  assert.match(root.error, /drive root/i, 'the refusal should name the real reason');
});

test('file_trash recycles the file the Git Bash path denotes, not the cwd-drive lookalike', { skip: !WINDOWS }, async () => {
  const trash = registeredTrash();
  const name = `dsh-cross-shell-${process.pid}`;
  const intendedDir = `C:\\${name}`;
  const lookalikeDir = `${process.cwd().slice(0, 2)}\\c\\${name}`;

  // The file the user meant, reachable as `/c/<name>/target.txt` from Git Bash.
  // Built with the literal-prefix spelling so the path can hold no surprise.
  const { mkdirSync } = await import('node:fs');
  mkdirSync(intendedDir, { recursive: true });
  writeFileSync(join(intendedDir, 'target.txt'), 'x', 'utf8');

  const result = await trash.execute({ paths: [`/c/${name}/target.txt`] }, {
    callId: 'cross-shell',
    name: 'file_trash',
    arguments: {},
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: CWD } } },
  });

  assert.deepEqual(result.failures, [], 'the call should not fail');
  assert.equal(result.recycled.length, 1, 'exactly one path should be recycled');
  assert.equal(existsSync(join(intendedDir, 'target.txt')), false, 'the intended file should be gone');
  // Nothing was created where the old resolution would have pointed.
  assert.equal(existsSync(lookalikeDir), false, 'no lookalike directory should have been touched');
});

// ---------------------------------------------------------------------------
// 2. Ambiguous tools are judged under both shells
// ---------------------------------------------------------------------------

test('a terminal command denied under either shell is denied', async () => {
  // bash refuses a mount-point delete; judging this as pwsh alone let it through.
  const result = await runHook('terminal_send', { text: 'rm -rf /tmp/x' });
  assert.equal(result.kind, 'deny');
  assert.equal(result.info.code, 'DELETE_GUARD_OPAQUE', 'this is a refusal, not a redirect');
  assert.match(result.reason, /mount point/i);
});

test('a terminal command both shells agree on is still steered to file_trash', async () => {
  const result = await runHook('terminal_send', { text: 'Remove-Item C:\\tmp\\a.txt' });
  // A redirect is delivered to the model as a denial whose reason says what to run
  // instead; the code is what tells the two apart.
  assert.equal(result.kind, 'deny');
  assert.equal(result.info.code, 'DELETE_GUARD_REWRITE', 'this is a redirect, not a refusal');
  assert.match(result.reason, /file_trash/);
});

test('a terminal command whose target means two different files is denied as ambiguous', async () => {
  const result = await runHook('terminal_send', { text: 'Remove-Item /c/tmp/x.txt' });
  assert.equal(result.kind, 'deny');
  assert.equal(result.info.code, 'DELETE_GUARD_OPAQUE');
  assert.match(result.reason, /two different things/i);
  // The denial has to say what to do instead, not just that it is ambiguous.
  assert.match(result.reason, /C:\\/);
});

test('a pwsh subexpression is still opaque through the terminal', async () => {
  const result = await runHook('terminal_send', { text: 'Remove-Item $(Get-ChildItem .)' });
  assert.equal(result.kind, 'deny');
  assert.equal(result.info.code, 'DELETE_GUARD_OPAQUE');
  assert.match(result.reason, /subexpression|\$\(/i);
});

test('dual judging does not leak onto the named shell tools', async () => {
  // A user running pwsh has never had a problem with `/tmp/x`; it must not start now.
  const viaPwsh = await runHook('pwsh', { command: 'rm /tmp/x' });
  assert.equal(viaPwsh.info.code, 'DELETE_GUARD_REWRITE', 'pwsh tool must keep its pwsh reading');

  // And bash keeps refusing it, so the two tools still differ as they should.
  const viaBash = await runHook('bash', { command: 'rm /tmp/x' });
  assert.equal(viaBash.info.code, 'DELETE_GUARD_OPAQUE');
});

test('an ordinary terminal command is untouched', async () => {
  const result = await runHook('terminal_send', { text: 'git status' });
  assert.equal(result.kind, 'next');
});
