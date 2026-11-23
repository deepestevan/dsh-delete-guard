/**
 * Registration smoke test.
 *
 * Loads the plugin entry with a fake Cordis context and runs its schemas
 * through the REAL JSON-Schema machinery from the installed dsh-tools, so the
 * parameter and output schemas are validated exactly as the host validates
 * them.
 *
 * Run: node --test test/registration.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { findDshModules, DSH_SKIP_REASON } from './dsh-install.mjs';

const DSH_MODULES = findDshModules();
const skip = DSH_MODULES === undefined ? DSH_SKIP_REASON : false;

// Only the schema cases need the host package; the hook cases do not.
const { validateJsonSchemaValue } = DSH_MODULES === undefined
  ? { validateJsonSchemaValue: () => [] }
  : await import(pathToFileURL(`${DSH_MODULES}/dsh-tools/lib/types/json-schema.js`).href);

/**
 * Build a minimal ctx that records registrations.
 * @returns the fake context plus its captured state.
 */
function makeContext() {
  const registered = [];
  const listeners = [];
  const sections = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    on(event, handler) {
      listeners.push({ event, handler });
      return () => {};
    },
    logger: { warn() {} },
  };
  return { ctx, registered, listeners, sections };
}

const { apply } = await import('../lib/index.js');

test('plugin registers two tools and one pre-execute hook', () => {
  const { ctx, registered, listeners, sections } = makeContext();
  apply(ctx, {});

  const names = registered.map((t) => t.name).sort();
  assert.deepEqual(names, ['file_trash', 'trash_status']);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].event, 'tools/pre-execute');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'delete-guard');
});

test('disabled config registers nothing', () => {
  const { ctx, registered, listeners } = makeContext();
  apply(ctx, { enabled: false });
  assert.equal(registered.length, 0);
  assert.equal(listeners.length, 0);
});

test('file_trash parameter and output schemas are accepted by the host', { skip }, () => {
  const { ctx, registered } = makeContext();
  apply(ctx, {});
  const trash = registered.find((t) => t.name === 'file_trash');

  // The definition carries a hand-authored JSON Schema (not the defineTool
  // authoring DSL), so it is checked with the host's JSON-Schema entry points:
  // `validateJsonSchemaValue` is exactly what `defineTool` binds for arguments.
  const validate = (args) => validateJsonSchemaValue(trash.parameters, args, '');

  assert.equal(trash.parameters.type, 'object');
  assert.ok(trash.parameters.properties.paths, 'paths property must be present');
  assert.deepEqual(trash.parameters.required, ['paths']);

  assert.deepEqual(validate({ paths: ['C:/tmp/a.txt'] }), [], 'valid args must produce no violations');

  // A missing required field is reported before our execute ever runs.
  const bad = validate({});
  assert.ok(bad.length > 0, 'missing required "paths" must be a violation');
  assert.match(bad.join(' '), /paths/);

  // A wrong element type is caught too.
  assert.ok(validate({ paths: [42] }).length > 0, 'non-string path elements must be a violation');
});

test('trash_status accepts a drive and tolerates omission', { skip }, () => {
  const { ctx, registered } = makeContext();
  apply(ctx, {});
  const status = registered.find((t) => t.name === 'trash_status');

  const validate = (args) => validateJsonSchemaValue(status.parameters, args, '');
  assert.deepEqual(validate({}), []);
  assert.deepEqual(validate({ drive: 'D:' }), []);
});

test('pre-execute hook denies a shell delete and names the tool to use', async () => {
  const { ctx, listeners } = makeContext();
  apply(ctx, {});
  const handler = listeners[0].handler;

  const decision = await handler(
    { name: 'pwsh', arguments: { command: 'Remove-Item C:\\tmp\\a.txt' }, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }),
  );

  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /file_trash/);
  assert.equal(decision.info.code, 'DELETE_GUARD_REWRITE');
});

test('pre-execute hook passes a non-delete command through', async () => {
  const { ctx, listeners } = makeContext();
  apply(ctx, {});
  const handler = listeners[0].handler;

  const decision = await handler(
    { name: 'pwsh', arguments: { command: 'Get-ChildItem .' }, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }),
  );

  assert.equal(decision.kind, 'allow');
});

test('pre-execute hook ignores tools that carry no shell command', async () => {
  const { ctx, listeners } = makeContext();
  apply(ctx, {});
  const handler = listeners[0].handler;

  const decision = await handler(
    { name: 'read', arguments: { path: 'C:/tmp/a.txt' }, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }),
  );

  assert.equal(decision.kind, 'allow');
});

test('denied deletes never reach the next handler', async () => {
  const { ctx, listeners } = makeContext();
  apply(ctx, {});
  const handler = listeners[0].handler;

  let reachedNext = false;
  await handler(
    { name: 'bash', arguments: { command: 'rm -rf /tmp/x' }, signal: new AbortController().signal },
    async () => {
      reachedNext = true;
      return { kind: 'allow' };
    },
  );

  assert.equal(reachedNext, false, 'a blocked delete must not fall through to the inner handler');
});

// --- 1.0.8: the persistent terminal, and Git Bash paths ---------------------

test('a delete typed into the persistent terminal is denied', async () => {
  // Regression, measured 2026-10-23: `terminal_send` types into a live PTY and
  // never goes through the pwsh/bash tools, so the hook used to return next()
  // and the delete ran. The guard now reads `text` too.
  const { ctx, listeners } = makeContext();
  apply(ctx, {});
  const handler = listeners[0].handler;

  let reachedNext = false;
  const decision = await handler(
    {
      name: 'terminal_send',
      arguments: { sessionId: 'pty-1', text: 'Remove-Item C:\\tmp\\a.txt' },
      signal: new AbortController().signal,
    },
    async () => {
      reachedNext = true;
      return { kind: 'allow' };
    },
  );

  assert.equal(reachedNext, false);
  assert.equal(decision.kind, 'deny');
  assert.ok(decision.reason.includes('"C:\\tmp\\a.txt"'), 'the redirect must name the parsed target');
});

test('a harmless command typed into the terminal still passes', async () => {
  const { ctx, listeners } = makeContext();
  apply(ctx, {});
  const handler = listeners[0].handler;

  const decision = await handler(
    {
      name: 'terminal_send',
      arguments: { sessionId: 'pty-1', text: 'git status' },
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'allow' }),
  );

  assert.equal(decision.kind, 'allow');
});

test('a Git Bash delete is redirected with a Windows path', async () => {
  const { ctx, listeners } = makeContext();
  apply(ctx, {});
  const handler = listeners[0].handler;

  const decision = await handler(
    { name: 'bash', arguments: { command: 'rm -rf /c/tmp/build' }, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }),
  );

  assert.equal(decision.kind, 'deny');
  assert.ok(decision.reason.includes('"C:\\tmp\\build"'), `expected a Windows path, got: ${decision.reason}`);
});

// --- 2026-11-14: content destroyed without a delete verb --------------------
//
// The rules are pure functions in lib/rewrite-guard.js and are unit-tested there.
// What these cases pin is the part a pure test cannot: that `apply()` actually
// wires them to the seam the host routes every tool call through, and that the
// config switch reaches them. A rule that exists in the classifier but never runs
// is the failure mode this plugin has already been bitten by once (a hook that
// looked registered and returned next()).

test('the 2026-11-14 truncation command is refused at the hook', async () => {
  const { ctx, listeners } = makeContext();
  apply(ctx, {});
  const handler = listeners[0].handler;

  const command = [
    '$lines=Get-Content $f',
    '$idx=($lines | Select-String -Pattern "anchor" | Select-Object -First 1).LineNumber',
    '$keep=$lines[0..($idx-2)]',
    'Set-Content -LiteralPath $f -Value $keep -Encoding UTF8',
  ].join('\n');

  let reachedNext = false;
  const decision = await handler(
    { name: 'pwsh', arguments: { command }, signal: new AbortController().signal },
    async () => {
      reachedNext = true;
      return { kind: 'allow' };
    },
  );

  assert.equal(reachedNext, false, 'the command must not run');
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.info.code, 'DELETE_GUARD_SLICE-RISK');
  assert.match(decision.reason, /if \(-not \$idx\)/);
});

test('an in-place rewrite is refused at the hook with the backup recipe', async () => {
  const { ctx, listeners } = makeContext();
  apply(ctx, {});
  const handler = listeners[0].handler;

  const decision = await handler(
    {
      name: 'pwsh',
      arguments: { command: '(Get-Content $f) | Set-Content -LiteralPath $f' },
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'allow' }),
  );

  assert.equal(decision.kind, 'deny');
  assert.equal(decision.info.code, 'DELETE_GUARD_IN-PLACE-REWRITE');
  assert.match(decision.reason, /\.bak-/, 'the fix must name the copy step');
});

test('blockTruncatingWrites: false lets the same command through', async () => {
  const { ctx, listeners } = makeContext();
  apply(ctx, { blockTruncatingWrites: false });
  const handler = listeners[0].handler;

  const decision = await handler(
    {
      name: 'pwsh',
      arguments: { command: '(Get-Content $f) | Set-Content -LiteralPath $f' },
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'allow' }),
  );

  assert.equal(decision.kind, 'allow', 'the documented switch must actually disable the rule');
});
