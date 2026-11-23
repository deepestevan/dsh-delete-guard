/**
 * Overwrite-guard tests: content destroyed without a delete verb.
 *
 * Every case here is a *regression from a measured incident* (2026-11-14: a
 * 605-line ledger rewritten to 24 lines by `Set-Content` after an anchor lookup
 * returned `$null`) or a *false positive that ordinary work would hit*. The two
 * halves are kept in the same file because that is the whole difficulty: a rule
 * that catches the incident but also refuses `npm run build` is not a fix, and a
 * rule that refuses nothing is not one either.
 *
 * Run: node --test test/rewrite.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand } from '../lib/guard.js';

const PWSH = { dialect: 'pwsh' };
const BASH = { dialect: 'bash' };

/**
 * The command from the incident record, verbatim in shape (§2): anchor lookup via
 * `Select-Object -First 1).LineNumber`, then `$lines[0..($idx-2)]`, then an
 * in-place `Set-Content` of the result over the same file.
 */
const INCIDENT = [
  "$f='\\\\HOST\\Share\\kb\\output\\_审计\\交流部分核对台账-20261114.md'",
  '$lines=Get-Content $f',
  "$idx=($lines | Select-String -Pattern '^# 备用｜同步电机' | Select-Object -First 1).LineNumber",
  '"header at line $idx"; $lines[$idx-1]',
  '$keep=$lines[0..($idx-2)]',
  "$new=@'\n# 备用\n'@",
  'Set-Content -LiteralPath $f -Value ($keep + $new) -Encoding UTF8',
].join('\n');

/** Assert a command is refused with a given kind. */
function assertDeny(command, kind, opts = PWSH) {
  const v = classifyCommand(command, opts);
  assert.equal(v.action, 'deny', `expected deny for ${JSON.stringify(command)}, got ${v.action}`);
  if (kind !== undefined) assert.equal(v.kind, kind, `kind mismatch for ${JSON.stringify(command)}`);
  return v;
}

/** Assert a command is left alone. */
function assertAllow(command, opts = PWSH) {
  const v = classifyCommand(command, opts);
  assert.equal(
    v.action,
    'allow',
    `expected allow for ${JSON.stringify(command)}, got ${v.action}/${v.kind ?? '-'}: ${v.reason ?? ''}`,
  );
}

// --- the incident ----------------------------------------------------------

test('the incident command is refused, and the reason names the null endpoint', () => {
  const v = assertDeny(INCIDENT, 'slice-risk');
  // The message has to be usable: the model must be able to see which variable is
  // unguarded and the exact one-line fix.
  assert.match(v.reason, /if \(-not \$idx\) \{ throw/);
  assert.match(v.reason, /\$lines\[0\.\.-2\]/);
  // A remedy that names file_trash would be wrong here: the target is on a UNC
  // share, which has no Recycle Bin (scripts/recycle-bin.ps1 refuses it).
  assert.doesNotMatch(v.reason, /file_trash/);
});

test('asserting the anchor clears the slice rule', () => {
  const fixed = INCIDENT.replace(
    '$keep=$lines[0..($idx-2)]',
    'if (-not $idx) { throw "anchor not found" }\n$keep=$lines[0..($idx-2)]',
  );
  const v = classifyCommand(fixed, PWSH);
  assert.notEqual(v.kind, 'slice-risk', 'an asserted endpoint is not the slice hazard');
});

test('the incident shape survives once the command makes its own copy', () => {
  // The record's §6 safe pattern, reduced to its essentials: copy → write temp →
  // verify → replace. Nothing here is refused.
  const safe = [
    "$f='C:\\kb\\output\\台账.md'",
    'Copy-Item -LiteralPath $f -Destination "$f.bak-20261114-101010"',
    '$lines = Get-Content -LiteralPath $f -Encoding utf8',
    '$idx = ($lines | Select-String -Pattern "^# 备用" | Select-Object -First 1).LineNumber',
    'if (-not $idx) { throw "anchor not found" }',
    '$keep = $lines[0..($idx-2)]',
    'Set-Content -LiteralPath "$env:TEMP\\fix.md" -Value $keep -Encoding utf8',
    '$chk = Get-Content -LiteralPath "$env:TEMP\\fix.md"',
    'if ($chk.Count -lt 2) { throw "line count mismatch" }',
    'Copy-Item -LiteralPath "$env:TEMP\\fix.md" -Destination $f -Force',
  ].join('\n');
  assertAllow(safe);
});

test('the same command after removing the copy step is refused', () => {
  // Same shape minus the `.bak` line: the write is now the only copy.
  const unsafe = [
    "$f='C:\\kb\\output\\台账.md'",
    '$lines = Get-Content -LiteralPath $f -Encoding utf8',
    '$keep = $lines[0..178]',
    'Set-Content -LiteralPath $f -Value $keep -Encoding utf8',
  ].join('\n');
  assertDeny(unsafe, 'in-place-rewrite');
});

// --- rule 1: read and write the same file ---------------------------------

test('every spelling of an in-place rewrite is refused', () => {
  const forms = [
    '(Get-Content $f) | Set-Content $f',
    'Get-Content $f | Select-Object -First 20 | Set-Content -LiteralPath $f',
    '$c = Get-Content $f; Set-Content $f ($c -join "`n")',
    '$j = Get-Content cfg.json -Raw | ConvertFrom-Json; Set-Content cfg.json ($j | ConvertTo-Json)',
    'Get-Content notes.md > notes.md',
    '$t=[System.IO.File]::ReadAllText($f); [System.IO.File]::WriteAllText($f,$t)',
  ];
  for (const cmd of forms) assertDeny(cmd, 'in-place-rewrite');
});

test('in-place editors are refused unless they keep a copy', () => {
  assertDeny("sed -i 's/a/b/' notes.md", 'in-place-rewrite', BASH);
  assertAllow("sed -i.bak 's/a/b/' notes.md", BASH);
});

test('a shell redirect that truncates the file it reads is refused', () => {
  assertDeny('cat f.txt > f.txt', 'in-place-rewrite', BASH);
  assertDeny('grep -v skip f.txt > f.txt', 'in-place-rewrite', BASH);
  // The glued spelling (no space around `>`) is the same redirect.
  assertDeny('cat f.txt>f.txt', 'in-place-rewrite', BASH);
});

test('writing over a file without reading it first is not this rule', () => {
  // `echo hi > notes.md` truncates `notes.md`, and the guard allows it: refusing
  // every redirect onto an existing file is the over-broad rule this plugin
  // rejected (it would refuse build logs, generated configs, and `write` itself).
  // What is refused is the *unrecoverable* combination — read, transform, replace
  // the only copy. Recorded in README 「不挡什么」.
  assertAllow('echo hi>f.txt', BASH);
  assertAllow('echo hi > notes.md', BASH);
});

test('rewriting a *different* file is not an in-place rewrite', () => {
  const forms = [
    'Get-Content a.md | Set-Content b.md',
    'Get-Content config.yml | Out-File config.new.yml',
    'Invoke-RestMethod $u | ConvertTo-Json | Set-Content -LiteralPath data.json',
    'Get-ChildItem $d | ForEach-Object { $_.Name } | Set-Content list.txt',
    "sed 's/a/b/' a.txt > b.txt",
    'Get-Process | Where-Object { $_.CPU -gt 10 } | Set-Content procs.txt',
    // A copy reads its source; only the destination is replaced.
    'Get-Content $f | Select-Object -First 3; Copy-Item -LiteralPath $f -Destination $g -Force',
  ];
  for (const cmd of forms) assertAllow(cmd);
  assertAllow("sed 's/a/b/' a.txt > b.txt", BASH);
});

test('creating, appending and discarding are not rewrites', () => {
  const forms = [
    "Set-Content -LiteralPath notes.md -Value '# Title'",
    '$obj | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath out.json -Encoding utf8',
    'Add-Content -LiteralPath log.txt -Value $entry',
    'echo hi >> log.txt',
    'Set-Content -LiteralPath log.txt -Value $entry -Append',
    'Clear-Content -LiteralPath log.txt',
    'Get-ChildItem . -ErrorAction SilentlyContinue 2> $null',
    'Get-Content f.txt > /dev/null',
  ];
  for (const cmd of forms) assertAllow(cmd);
  assertAllow('find . -name "*.tmp" 2>/dev/null | head', BASH);
});

test('a literal path on one side and a variable on the other still match', () => {
  // `$f='C:\x\a.md'` … `Get-Content $f` … `Set-Content 'C:\x\a.md'`.
  assertDeny(
    "$f='C:\\x\\a.md'; $c = Get-Content $f; Set-Content -LiteralPath 'C:\\x\\a.md' -Value $c",
    'in-place-rewrite',
  );
});

// --- rule 2: unchecked slice endpoints ------------------------------------

test('an unasserted offset endpoint only matters when the command writes', () => {
  const readOnly = '$keep=$lines[0..($idx-2)]; "kept $($keep.Count) lines"';
  assertAllow(readOnly); // wrong output, but the file survives
  assertDeny('$keep=$lines[0..($idx-2)]; Set-Content -LiteralPath $out -Value $keep', 'slice-risk');
});

test('endpoints that cannot be null are not the slice hazard', () => {
  const safe = [
    '$lines[0..178]',
    '$n = $lines.Count; $lines[0..($n-1)]',
    '$lines[0..($lines.Count-1)]',
  ];
  for (const cmd of safe) assertAllow(cmd);
});

test('an index this command cannot account for is refused, not assumed safe', () => {
  // `$i` is never assigned here: it can only come from an earlier command, so its
  // provenance — and therefore its nullability — is not visible to the guard. The
  // message tells the model to assert it in the same command.
  assertDeny('$tail = $lines[($i-3)..($i-1)]; Set-Content -LiteralPath $log -Value $tail', 'slice-risk');
});

test('a proven-safe index keeps its command allowed', () => {
  // `$idx = 5` cannot be null; nothing to assert.
  assertAllow('$idx = 5; $keep = $lines[0..($idx-2)]; Set-Content -LiteralPath $out -Value $keep');
});

test('the count-argument spellings of the same hazard are seen', () => {
  assertDeny(
    '$i = ($l | Select-String "x" | Select-Object -First 1).LineNumber;'
      + ' $head = $l | Select-Object -First ($i-1); Set-Content -LiteralPath $f -Value $head',
    'slice-risk',
  );
});

test('assertion in any of the usual spellings clears it', () => {
  const base = '$keep=$lines[0..($idx-2)]; Set-Content -LiteralPath $out -Value $keep';
  for (const guard of [
    'if ($idx -eq $null) { throw "no anchor" }',
    'if ($null -eq $idx) { throw "no anchor" }',
    'if (-not $idx) { throw "no anchor" }',
    'if (!$idx) { throw "no anchor" }',
    'if ($idx -le 0) { throw "no anchor" }',
  ]) {
    const v = classifyCommand(`${guard}; ${base}`, PWSH);
    assert.notEqual(v.kind, 'slice-risk', `assertion not recognised: ${guard}`);
  }
});

// --- precedence and policy switches ---------------------------------------

test('a command that both deletes and truncates reports the truncation', () => {
  // Routing this to file_trash would delete the file instead of rewriting it —
  // the wrong remedy. The truncation verdict must win.
  const v = classifyCommand(
    '$c = Get-Content $f; Set-Content $f $c; Remove-Item C:\\tmp\\old.txt',
    PWSH,
  );
  assert.equal(v.action, 'deny');
  assert.equal(v.kind, 'in-place-rewrite');
});

test('blockTruncatingWrites turns both rules off', () => {
  const relaxed = { ...PWSH, blockTruncatingWrites: false };
  assertAllow(INCIDENT, relaxed);
  assertAllow('(Get-Content $f) | Set-Content $f', relaxed);
});

test('a plain delete still redirects to file_trash', () => {
  // The new rules must not have taken over the old path.
  const v = classifyCommand('Remove-Item C:\\tmp\\a.txt', PWSH);
  assert.equal(v.action, 'rewrite');
  assert.deepEqual(v.targets, ['C:\\tmp\\a.txt']);
});

// --- ordinary work must keep working --------------------------------------
//
// The counter-evidence set. If a future rule makes any of these refuse, the trade
// was paid in the wrong currency: nothing here can lose data.

test('ordinary build, git, and inspection commands stay allowed', () => {
  const ordinary = [
    ['Get-ChildItem -Recurse -File | Measure-Object -Property Length -Sum', PWSH],
    ['$lines = Get-Content $f; $lines.Count', PWSH],
    ['Get-Content $f | Select-String -Pattern "anchor"', PWSH],
    ['Get-Content $f -Tail 20 | Select-Object -First 5', PWSH],
    ['Get-Content $f | ForEach-Object { $_ -replace "a", "b" }', PWSH],
    ['npm install', PWSH],
    ['node test/run-all.mjs', PWSH],
    ['git status --short', PWSH],
    ['git add -A; git commit -m "msg"', PWSH],
    ['(Get-ChildItem . -Recurse -File | Measure-Object).Sum', PWSH],
    ['Copy-Item -LiteralPath a.txt -Destination b.txt -Force', PWSH],
    ['ls -la; pwd', BASH],
    ['cat a.txt | sort | uniq', BASH],
    ['grep -n foo a.txt | head -5', BASH],
  ];
  for (const [cmd, opts] of ordinary) assertAllow(cmd, opts);
});

test('known gaps stay gaps (documented in README, not silently covered)', () => {
  // These *can* destroy a file's content and are not detected. Pinning them here
  // makes the README's 「不挡什么」 table checkable instead of aspirational: if one
  // of these starts being refused, the documentation has to change in the same
  // commit.
  const gaps = [
    "Invoke-WebRequest $u -OutFile $f",
    'git checkout -- docs/notes.md',
  ];
  for (const cmd of gaps) assertAllow(cmd);
});
