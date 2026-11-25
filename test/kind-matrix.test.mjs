/**
 * Layer ⑫: every refusal the classifier can produce must survive the hook's pre-filter.
 *
 * The hook skips `classifyCommand` when `MAY_TOUCH_FILES` does not match, on the claim
 * that the filter is over-inclusive. Nothing checked that claim, and it was false:
 * `[System.IO.File]::Delete(…)` was refused by `classifyCommand` — `guard.test.mjs`
 * asserts exactly that — while the hook let it through to the host, which erased the
 * file. The protection existed only on a path that never runs.
 *
 * A corpus cannot catch this. 6,000 real commands from this machine were swept and
 * produced zero violations, because none of them contained the shape. A corpus shows
 * that a gap was not hit; it cannot show the rule set is covered. This does: one
 * representative per rule family, driven through `apply()`.
 *
 * When a rule is added to `guard.js`, add its representative here. The kinds list below
 * is asserted, so a kind cannot lose its last representative silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyCommand } from '../lib/guard.js';
import { apply } from '../lib/index.js';

/**
 * One representative per rule family, in both shells where the rule covers both.
 *
 * Each entry is `[command, tool?]`: the tool decides the dialect, and a few rules are
 * dialect-scoped (`find -delete` is bash-only, the .NET APIs are pwsh-only). Getting
 * this wrong makes the case look like a hole in the gate when it is simply not a
 * refusal in that shell.
 */
const CASES = [
  // delete — the ordinary verbs
  ['Remove-Item C:\\tmp\\a.txt'],
  ['ri C:\\tmp\\a.txt'],
  ['del C:\\tmp\\a.txt'],
  ['erase C:\\tmp\\a.txt'],
  ['rd C:\\tmp\\d'],
  ['rm C:\\tmp\\a.txt'],
  ['unlink /c/tmp/x'],

  // erase-api — the .NET family, which is what the gate used to hide
  ["[System.IO.File]::Delete('C:\\tmp\\x.txt')"],
  ["[System.IO.Directory]::Delete('C:\\tmp\\d', $true)"],
  ["[System.IO.FileInfo]::new('C:\\tmp\\x').Delete()"],
  ["[System.IO.DirectoryInfo]::new('C:\\tmp\\d').Delete($true)"],
  ["[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('C:\\tmp\\x')"],
  ["[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('C:\\tmp\\d')"],
  ['$t = [System.IO.File]; $t::Delete(\'C:\\tmp\\x.txt\')'],
  ['Invoke-Expression "Remove-Item C:\\x\\a.txt"'],
  ['iex "Remove-Item C:\\x\\a.txt"'],
  ['cmd /c del C:\\x\\a.txt'],
  ['robocopy src dst /MIR'],
  ['robocopy src dst /PURGE'],
  ['find . -name "*.log" -delete', 'bash'],

  // opaque — target set unknowable
  ['Remove-Item $(Get-ChildItem .)'],
  ['Remove-Item `Get-Date`'],
  ['Remove-Item $var'],
  ['Remove-Item ${TARGET_DIR}'],
  ['echo x | Remove-Item'],
  ['xargs rm < list.txt', 'bash'],
  ['Remove-Item -Recurse *'],
  ['Remove-Item @targets'],

  // wipe — permanent-erase programs
  ['sdelete -p 3 C:\\secret.txt'],
  ['sdelete64 -p 3 C:\\secret.txt'],
  ['shred -u /tmp/x'],
  ['srm -rf /tmp/x'],
  ['cipher /w:C:\\tmp'],
  ['format D:'],
  ['bash -c "shred -u /tmp/x"'],

  // empty-recycle
  ['Clear-RecycleBin -Force'],
  ['Clear-RecycleBin -DriveLetter C -Force'],
  ['[Microsoft.VisualBasic.FileIO.FileSystem]::SHEmptyRecycleBin()'],

  // in-place-rewrite
  ['Get-Content f | Set-Content f'],
  ['cat f > f', 'bash'],
  ['Set-Content f (Get-Content f)'],
  ['[System.IO.File]::WriteAllText($p, [System.IO.File]::ReadAllText($p))'],

  // script — deletes inside a body handed to a child interpreter
  ['bash -c "rm -rf /tmp/x"'],
  ["node -e \"require('fs').rmSync('x', {recursive:true})\""],
  ['python -c "import shutil; shutil.rmtree(\'x\')"'],
];

/** The tool each case is driven through: the dialect follows from it. */
const TOOL_OF = (entry) => entry[1] ?? 'pwsh';
/** The command text of a case. */
const TEXT_OF = (entry) => entry[0];
/** The dialect the tool implies. */
const DIALECT_OF = (tool) => (tool === 'bash' ? 'bash' : 'pwsh');

/** Marker for "the hook let the call through". */
const NEXT = { kind: 'next' };

/**
 * Register the plugin and return its pre-execute hook.
 * @returns the hook function.
 */
function hook() {
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
  return handlers[0];
}

const pre = hook();

/**
 * Drive one command through the real hook.
 * @param entry - `[command, tool?]`.
 * @returns 'PASS' when the call was let through, else the guard code.
 */
async function viaHook(entry) {
  const tool = TOOL_OF(entry);
  const field = tool === 'terminal_send' ? 'text' : 'command';
  let passed = false;
  const out = await pre({ name: tool, arguments: { [field]: TEXT_OF(entry) }, callId: 'kind-matrix' }, async () => {
    passed = true;
    return NEXT;
  });
  return passed ? 'PASS' : out.info?.code ?? '?';
}

test('no refusal is hidden from the hook by the pre-filter', async () => {
  const hidden = [];
  for (const entry of CASES) {
    const verdict = classifyCommand(TEXT_OF(entry), { dialect: DIALECT_OF(TOOL_OF(entry)) });
    assert.notEqual(verdict.action, 'allow', `case must be a refusal to test anything: ${TEXT_OF(entry)}`);

    const hooked = await viaHook(entry);
    if (hooked === 'PASS') hidden.push(`${verdict.action}/${verdict.kind}: ${TEXT_OF(entry)}`);
  }
  assert.deepEqual(hidden, [], `the hook let these through while the classifier refused them:\n${hidden.join('\n')}`);
});

test('every classifier kind is represented, so a kind cannot lose its coverage', () => {
  const kinds = new Set();
  for (const entry of CASES) {
    const verdict = classifyCommand(TEXT_OF(entry), { dialect: DIALECT_OF(TOOL_OF(entry)) });
    if (verdict.action !== 'allow') kinds.add(verdict.kind);
  }
  for (const expected of ['delete', 'erase-api', 'opaque', 'wipe', 'empty-recycle', 'in-place-rewrite', 'script']) {
    assert.ok(kinds.has(expected), `no representative produces kind "${expected}"`);
  }
});

test('the hook verdict is the classifier verdict, not merely "not pass"', async () => {
  // Passing the gate is not enough: the two paths must agree on *which* refusal, so a
  // gate that happened to admit a command into the wrong rule would still show up.
  const CODE_FOR = {
    delete: 'DELETE_GUARD_REWRITE',
    'in-place-rewrite': 'DELETE_GUARD_IN-PLACE-REWRITE',
    wipe: 'DELETE_GUARD_WIPE',
    'empty-recycle': 'DELETE_GUARD_EMPTY-RECYCLE',
    opaque: 'DELETE_GUARD_OPAQUE',
    'erase-api': 'DELETE_GUARD_ERASE-API',
    script: 'DELETE_GUARD_SCRIPT',
  };
  for (const entry of CASES) {
    const verdict = classifyCommand(TEXT_OF(entry), { dialect: DIALECT_OF(TOOL_OF(entry)) });
    const expected = CODE_FOR[verdict.kind];
    assert.ok(expected !== undefined, `no expected hook code for kind "${verdict.kind}"`);
    assert.equal(await viaHook(entry), expected, `hook code differs for: ${TEXT_OF(entry)}`);
  }
});

test('ordinary commands still pass untouched', async () => {
  for (const command of [
    'git status',
    'ls -la',
    'Get-ChildItem -Force',
    'npm run build',
    'cat README.md',
    '[System.IO.File]::Exists("C:\\x")',
    '[System.IO.File]::ReadAllText("C:\\x")',
    'echo hello > out.txt',
    // A non-filesystem provider holds nothing a Recycle Bin could receive, so the
    // operand is skipped rather than refused — `file_trash variable:x` is an
    // instruction that cannot work.
    'Remove-Item variable:x',
    'Remove-Item env:PATH',
  ]) {
    assert.equal(await viaHook([command]), 'PASS', `should be untouched: ${command}`);
  }
});
