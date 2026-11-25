/**
 * Layer ⑭: the arguments `file_trash` accepts, and what it says when it cannot.
 *
 * A real session sent `paths` as a bare string four times — absolute, workspace-relative,
 * then forward slashes — because the refusal said only "no usable paths were supplied".
 * The intent was identical every time; the shape was wrong and nothing said so. The model
 * burned four turns and left a directory behind it could not remove.
 *
 * So this layer pins both halves: a single path written as a string means what it looks
 * like it means, and a truly unusable argument says what arrived.
 *
 * Windows-only: it recycles real files through SHFileOperationW.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

const WINDOWS = process.platform === 'win32';

/** Collect the registered `file_trash`. */
function trashTool() {
  const registered = [];
  apply({
    tools: { register: (d) => (registered.push(d), () => {}) },
    systemPrompt: { section: () => () => {} },
    on: () => () => {},
    logger: { warn() {} },
  }, {});
  return registered.find((t) => t.name === 'file_trash');
}

const trash = trashTool();

/** Run the tool with one `paths` argument. */
async function run(paths, cwd) {
  return trash.execute({ paths }, {
    callId: 'shape',
    name: 'file_trash',
    arguments: {},
    signal: new AbortController().signal,
    agent: { session: { header: { cwd } } },
  });
}

const ROOT = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `dsh-shape-${process.pid}`);

/**
 * Create the probe directory and one file in it.
 * @param name - file name.
 * @returns the absolute path.
 */
function seed(name) {
  mkdirSync(ROOT, { recursive: true });
  const file = join(ROOT, name);
  writeFileSync(file, 'x', 'utf8');
  return file;
}

test('a single path as a bare string is accepted', { skip: !WINDOWS }, async () => {
  const file = seed('bare.txt');
  const result = await run(file, ROOT);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.recycled, [file]);
  assert.equal(existsSync(file), false);
});

test('a one-element array still works, and forward slashes with it', { skip: !WINDOWS }, async () => {
  const file = seed('slashes.txt');
  const result = await run([file.replace(/\\/g, '/')], ROOT);
  assert.deepEqual(result.failures, []);
  assert.equal(result.recycled.length, 1);
});

test('a path relative to the workspace resolves against the cwd', { skip: !WINDOWS }, async () => {
  const file = seed('relative.txt');
  const result = await run('relative.txt', ROOT);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.recycled, [file]);
});

test('an unusable argument says what arrived instead', { skip: !WINDOWS }, async () => {
  const cases = [
    [undefined, /received nothing/],
    [[], /received an empty array/],
    [['', '   '], /2 entries, none a usable path/],
    [42, /type number/],
  ];
  for (const [paths, pattern] of cases) {
    const result = await run(paths, ROOT);
    const message = result.failures[0]?.error ?? '';
    assert.match(message, pattern, `unhelpful message for ${JSON.stringify(paths)}: ${message}`);
    // And it has to say what to do, not only what was wrong.
    assert.match(message, /paths = \[/, `no example given for ${JSON.stringify(paths)}`);
  }
});

test('an array that arrived as its own JSON text is read back', { skip: !WINDOWS }, async () => {
  // Some adapters serialise array arguments into a string. Treated as a path, the text
  // becomes one enormous file name and the caller gets a `no such file` at a location it
  // never wrote. Measured 2026-11-25 in a live session, twice.
  const one = seed('json-one.txt');
  const two = seed('json-two.txt');

  const single = await run(JSON.stringify([one]), ROOT);
  assert.deepEqual(single.failures, [], `single-element JSON text not unwrapped: ${JSON.stringify(single.failures)}`);
  assert.deepEqual(single.recycled, [one]);

  const pair = await run(JSON.stringify([two]), ROOT);
  assert.deepEqual(pair.failures, []);
  assert.deepEqual(pair.recycled, [two]);
});

test('every spelling of a path list reaches the same list', { skip: !WINDOWS }, async () => {
  // The rewrite replaced "enumerate the shapes" with "converge on the meaning", so this
  // pins the property rather than the cases: nesting, a JSON text inside an array, and a
  // stray non-string all have to reduce to the same paths. Each shape gets fresh files —
  // a recycled path cannot be recycled twice.
  let n = 0;
  const pair = () => [seed(`spell-a-${n}.txt`), seed(`spell-b-${n++}.txt`)];

  const build = {
    array: ([a, b]) => [a, b],
    nested: ([a, b]) => [[a], [b]],
    mixed: ([a, b]) => [a, 42, null, b],
    'json inside array': ([a, b]) => [JSON.stringify([a]), b],
  };

  for (const [label, shape] of Object.entries(build)) {
    const files = pair();
    const result = await run(shape(files), ROOT);
    assert.deepEqual(result.failures, [], `${label} produced failures: ${JSON.stringify(result.failures)}`);
    assert.equal(result.recycled.length, 2, `${label} did not yield both paths`);
  }
});

test('a file whose name merely looks bracketed is still one path', { skip: !WINDOWS }, async () => {
  // `[notes].txt` is a legal Windows file name and does not parse as JSON, so it must not
  // be unwrapped into something else.
  const file = seed('[notes].txt');
  const result = await run(file, ROOT);
  assert.deepEqual(result.failures, [], `bracketed file name mishandled: ${JSON.stringify(result.failures)}`);
  assert.deepEqual(result.recycled, [file]);
});

test('the probe directory still recycles after the tool handled a string', { skip: !WINDOWS }, async () => {
  // The reported session could not remove its directory at all: every attempt was a
  // string, so the directory was never reached.
  const result = await run(ROOT, ROOT);
  assert.deepEqual(result.failures, [], `directory not recycled: ${JSON.stringify(result.failures)}`);
  assert.equal(existsSync(ROOT), false, 'the probe directory should be gone');
});
