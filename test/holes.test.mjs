/**
 * Regression tests for the P1 findings of the 2026-11-24 corpus sweep:
 * dry runs, bin verbs, provider paths, indirect shells, and the erase-tool scoping.
 *
 * Every case here was measured against the working tree before the fix, and the
 * direction it must move is stated with it.
 *
 * Run: node --test test/holes.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand } from '../lib/guard.js';
import { apply } from '../lib/index.js';

const PWSH = { dialect: 'pwsh' };

/** Assert a command is refused with a given kind. */
function assertDeny(command, kind) {
  const v = classifyCommand(command, PWSH);
  assert.equal(v.action, 'deny', `expected deny for ${JSON.stringify(command)}, got ${v.action}/${v.kind ?? '-'}`);
  if (kind !== undefined) assert.equal(v.kind, kind, `kind mismatch for ${JSON.stringify(command)}`);
}

/** Assert a command is left alone. */
function assertAllow(command) {
  const v = classifyCommand(command, PWSH);
  assert.equal(v.action, 'allow', `expected allow for ${JSON.stringify(command)}, got ${v.action}/${v.kind ?? '-'}: ${v.reason ?? ''}`);
}

/**
 * Drive the plugin's pre-execute hook, which is where a dry run is rendered.
 * @param command - the shell command text.
 * @returns the decision object.
 */
async function hook(command) {
  const listeners = [];
  apply({
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    on: (event, handler) => (listeners.push({ event, handler }), () => {}),
    logger: { warn() {} },
  }, {});
  const handler = listeners.find((l) => l.event === 'tools/pre-execute').handler;
  return handler(
    { name: 'pwsh', arguments: { command }, signal: new AbortController().signal },
    async () => ({ kind: 'allow' }),
  );
}

// --- dry runs --------------------------------------------------------------
//
// `-WhatIf` is a preview. The guard used to classify it as `rewrite/delete` and tell
// the model to re-run it as `file_trash` — i.e. a user asking to preview was advised
// to destroy the file. That is a safety inversion, not a false positive.

test('a dry run is never rewritten into a real deletion', async () => {
  // A `rewrite` verdict is the dangerous one: it renders as "re-run this as
  // file_trash". A dry run must never produce that.
  //
  // A command whose deletes all carry `-WhatIf` previews and deletes nothing, so the guard
  // lets it through untouched — a refusal would protect nothing and cost a round. What
  // matters is that no `file_trash` instruction is produced for it.
  for (const cmd of [
    'Remove-Item -LiteralPath C:\\tmp\\a.txt -WhatIf',
    'Remove-Item -WhatIf C:\\tmp\\a.txt',
  ]) {
    const d = await hook(cmd);
    assert.equal(d.kind, 'allow', `a preview deletes nothing, so it is passed through: ${cmd}`);
    assert.doesNotMatch(d.reason ?? '', /Re-run this as/);
  }

  // Mixing a preview with a real delete is still refused: one deny covers the whole call,
  // so the rewrite instruction would name the previewed path as well.
  const mixed = await hook('Remove-Item -WhatIf a.txt; Remove-Item b.txt');
  assert.equal(mixed.kind, 'deny');
  assert.equal(mixed.info.code, 'DELETE_GUARD_DRY_RUN');
  assert.doesNotMatch(mixed.reason, /Re-run this as/);

  // `Clear-RecycleBin` is refused outright (not rewritten), which is already safe:
  // the model gets a refusal, not a delete instruction. Assert only that no
  // file_trash instruction is produced.
  const bin = await hook('Clear-RecycleBin -Force -WhatIf');
  assert.equal(bin.kind, 'deny');
  assert.doesNotMatch(bin.reason, /Re-run this as/);
});

test('a real write that merely mentions -WhatIf is not a dry run', async () => {
  // A textual test for the flag was fooled by both of these; token-level is not.
  for (const cmd of [
    '$f="a.md"; $t=Get-Content $f -Raw; Set-Content $f $t  # always -WhatIf first',
    '$f="a.md"; Set-Content -LiteralPath $f -Value "run -WhatIf then finish"',
    'Remove-Item a.txt  # we used -WhatIf first',
  ]) {
    const d = await hook(cmd);
    assert.notEqual(d.info?.code, 'DELETE_GUARD_DRY_RUN', `must not be treated as a dry run: ${cmd}`);
  }
});

test('-WhatIf:$false really executes, so it is not a dry run', async () => {
  const d = await hook('Remove-Item C:\\tmp\\a.txt -WhatIf:$false');
  assert.equal(d.kind, 'deny');
  assert.equal(d.info.code, 'DELETE_GUARD_REWRITE');
});

test('switch parameters do not swallow their operand', () => {
  // `-WhatIf`/`-Confirm`/`-Verbose`/`-Debug` take no value. Listing them as
  // value-taking made `Remove-Item -Verbose C:\x\a.txt` report "no explicit
  // operands" — the model was told its delete had no target.
  const v = classifyCommand('Remove-Item -Verbose C:\\tmp\\a.txt -Force', PWSH);
  assert.equal(v.action, 'rewrite');
  assert.deepEqual(v.targets, ['C:\\tmp\\a.txt']);
});

// --- the Recycle Bin's own verbs -------------------------------------------
//
// `.Verbs()` enumerates; only `DoIt()` / `InvokeVerb(…)` drive. Listing the
// enumeration as a driver refused the sanctioned restore path that the README
// promises to allow.

test('enumerating bin verbs or restoring is allowed', () => {
  for (const cmd of [
    '$s=New-Object -ComObject Shell.Application; $s.Namespace(10).Items() | % { $_.Verbs() | % { $_.Name } }',
    '$item | ForEach-Object { $verb = $_.Verbs() | Where-Object { $_.Name -like "*还原*" }; "found: " + $verb.Name }',
    "$i.InvokeVerb('Restore')",
    '$s=New-Object -ComObject Shell.Application; @($s.Namespace(10).Items()).Count',
  ]) {
    assertAllow(cmd);
  }
});

test('driving a bin verb is refused, even with no Namespace text', () => {
  // `$i.InvokeVerb('delete')` on its own was allowed until 2.4.2: the rule required
  // a bin reference *and* a driver in the same command.
  assertDeny("$i.InvokeVerb('delete')", 'empty-recycle');
  assertDeny('$i.Verbs() | % { $_.DoIt() }', 'empty-recycle');
  assertDeny('Clear-RecycleBin -Force', 'empty-recycle');
});

test('a comment saying "restore" does not launder DoIt()', () => {
  // A "restore word anywhere in the line" exemption was fooled by a bare comment.
  assertDeny('$s.Namespace(10).Items() | % { $_.DoIt() }  # restore is a different verb', 'empty-recycle');
  assertDeny('$s.Namespace(10).Items() | % { $_.DoIt() }  # 还原步骤见文档', 'empty-recycle');
});

// --- PowerShell providers -------------------------------------------------

test('a provider that holds no files is not a delete', () => {
  // Deleting a variable is not deleting a file; routing it to the bin produced the
  // instruction `file_trash "variable:helper"`, which cannot work.
  for (const cmd of [
    'Remove-Item variable:helper',
    'Remove-Item env:MY_VAR',
    'Remove-Item function:prompt',
    'Remove-Item alias:ls',
    'Remove-Item -Path variable:helper -ErrorAction SilentlyContinue',
  ]) {
    assertAllow(cmd);
  }
  // Consistent with the cmdlet spellings that were already allowed.
  assertAllow('Remove-Variable helper');
});

test('a provider holding durable state is refused without a file_trash hint', () => {
  for (const cmd of ['Remove-Item HKCU:\\Software\\Foo', 'Remove-Item Cert:\\CurrentUser\\My\\ABC']) {
    const v = classifyCommand(cmd, PWSH);
    assert.equal(v.action, 'deny', cmd);
    assert.doesNotMatch(v.reason, /file_trash/, `must not route a registry/cert delete to the bin: ${cmd}`);
  }
});

// --- interpreters ---------------------------------------------------------

test('a shell invoked through a variable is refused when its body deletes', () => {
  // This was allowed: the program is a variable, so no rule could read what runs.
  assertDeny("$shellPath='C:\\x\\bash.exe'; & $shellPath -c 'rm -rf /tmp/x'", 'opaque');
  assertDeny("$sh='bash'; & $sh -c 'rm -rf /tmp/x'", 'opaque');
  // A harmless body is still allowed — the direct spelling `bash -c "ls -la"` is.
  assertAllow("$shellPath='C:\\x\\bash.exe'; & $shellPath -c 'ls -la'");
});

test('a destructured child_process import is not a hiding place', () => {
  // Every SPAWN_CALL branch required a leading dot, so `execSync(...)` after
  // `const {execSync} = require('child_process')` was invisible.
  const v = classifyCommand(
    'node -e "const {execSync}=require(\'child_process\'); execSync(\'shred -u x\')"',
    PWSH,
  );
  assert.equal(v.action, 'deny');
  assert.equal(v.kind, 'wipe');
});

test('an inline body is judged by its text, not by a word that happens to appear', () => {
  // `node -e "…{dialect:'pwsh'}…"` used to be audited as a shell script because the
  // literal `pwsh` appeared anywhere in it.
  assertAllow('node -e "const v = c(s, {dialect:\'pwsh\'}); console.log(v)"');
  // Invoke-Expression is judged by its body.
  assertAllow('Invoke-Expression "Write-Output \'hello\'"');
  assertDeny('Invoke-Expression "Remove-Item C:\\tmp\\a.txt"', 'erase-api');
});
