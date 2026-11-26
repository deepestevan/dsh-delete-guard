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

test('in-place editors are refused unless they keep a copy or stay bounded', () => {
  // An unanchored, non-empty substitution pattern is the sed spelling of `edit`: it cannot
  // drop a line or blank one. Everything that can (`d`, whole-line patterns) stays refused —
  // see the sed test above — and `-i.bak` keeps the copy.
  assertAllow("sed -i 's/a/b/' notes.md", BASH);
  assertDeny("sed -i 's/^.*//' notes.md", 'in-place-rewrite', BASH);
  assertDeny("sed -i '/a/,/b/d' notes.md", 'in-place-rewrite', BASH);
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
    'Get-ChildItem . -ErrorAction SilentlyContinue 2> $null',
    'Get-Content f.txt > /dev/null',
  ];
  for (const cmd of forms) assertAllow(cmd);
  assertAllow('find . -name "*.tmp" 2>/dev/null | head', BASH);
});

test('a backup only counts when it is a real copy of this file', () => {
  // The destination marker used to be enough on its own, so a backup of some *other* file
  // exempted the rewrite: `Copy-Item b.md b.md.bak; …; Set-Content a.md $t` was allowed,
  // and so was writing the new content to `$env:TEMP` first (measured 2026-11-26, after
  // 2.4.5 widened the marker to `.tmp`/`.new`).
  assertDeny('Copy-Item b.md b.md.bak; $t=Get-Content a.md -Raw; Set-Content a.md $t', 'in-place-rewrite');
  assertDeny('Copy-Item c.md c.md.tmp; $t=Get-Content a.md -Raw; Set-Content a.md $t', 'in-place-rewrite');
  assertDeny(
    '$o="$env:TEMP\\x.tmp"; $t=Get-Content a.md -Raw; Set-Content $o $t; Copy-Item $o a.md -Force',
    'in-place-rewrite',
  );
  // A copy of the file itself, taken first, still passes — whatever it is named.
  assertAllow('$t=Get-Content a.md -Raw; Copy-Item a.md a.md.bak; Set-Content a.md $t');
  assertAllow('$t=Get-Content a.md -Raw; Copy-Item a.md a.md.tmp; Set-Content a.md $t');
});

test('the bounded exemption is for one file with one codec', () => {
  // A substitution that belongs to one file used to exempt any other in-place rewrite in
  // the same command, and the codec values were never compared.
  assertDeny(
    "$a=Get-Content a.md -Raw -Encoding utf8; $a=$a.Replace('x','y'); Set-Content a.md $a -Encoding utf8; "
      + '$b=(Get-Content b.md).ToUpper(); Set-Content b.md $b',
    'in-place-rewrite',
  );
  assertDeny(
    "$t=Get-Content a.md -Raw -Encoding utf8; $t=$t.Replace('x','y'); Set-Content a.md $t -Encoding ascii",
    'in-place-rewrite',
  );
  assertAllow("$t=Get-Content a.md -Raw -Encoding utf8; $t=$t.Replace('x','y'); Set-Content a.md $t -Encoding utf8");
});

test('a name rebound to another file is a read of one file and a write of another', () => {
  // Taking the last assignment for both sides made the read of `a.md` look like a read of
  // `b.md`, refusing a command that never rewrote anything in place (measured 2026-11-26).
  assertAllow("$f='a.md'; Get-Content $f; $f='b.md'; Set-Content $f 'x'");
});

test('sed -i passes on a bounded script and is refused otherwise', () => {
  // `sed` cannot take `-Encoding` and does not transcode, so the codec half of the
  // exemption cannot apply to it. What matters is the script: a bounded substitution keeps
  // every byte it does not match; `d` and whole-line patterns do not. The program is the
  // same whichever tool carries the text, so this is judged in both dialects.
  for (const opts of [BASH, PWSH]) {
    assertAllow('sed -i "s/a/b/g" f.txt', opts);
    assertAllow('sed -i "s/a/b/; s/c/d/" f.txt', opts);
    assertAllow('sed -i.bak "s/a/b/g" f.txt', opts);
    assertDeny('sed -i "/x/d" f.txt', 'in-place-rewrite', opts);
    assertDeny('sed -i "1,$d" f.txt', 'in-place-rewrite', opts);
    assertDeny('sed -i "s/.*//" f.txt', 'in-place-rewrite', opts);
  }
});

test('a write that leaves the file empty is refused', () => {
  // The third shape: the file survives and its content does not. None of the rules above
  // fires on these — nothing is read and no slice endpoint is involved — so they were
  // allowed while a read-modify-write was refused (measured 2026-11-26). The write *with*
  // content stays allowed: refusing `echo x > f` would mean refusing `write`/`edit`.
  for (const cmd of [
    'Clear-Content -LiteralPath notes.md',
    "Set-Content -LiteralPath notes.md -Value ''",
    'Set-Content -LiteralPath notes.md -Value $null',
    "Set-Content notes.md ''",
    'Out-File notes.md -Value ""',
    'truncate -s 0 notes.md',
    ': > notes.md',
    '> notes.md',
    'cp /dev/null notes.md',
  ]) {
    assertDeny(cmd, 'empty-write');
  }
  for (const cmd of [
    "Set-Content -LiteralPath notes.md -Value '# Title'",
    'echo hi > notes.md',
    'Add-Content -LiteralPath notes.md -Value ""',
    'New-Item -ItemType File -Path notes.md',
  ]) {
    assertAllow(cmd);
  }
  // `blockEmptyWrites: false` is its own switch, independent of the truncating rules.
  const off = classifyCommand('Clear-Content -LiteralPath notes.md', { ...PWSH, blockEmptyWrites: false });
  assert.equal(off.action, 'allow');
  assert.equal(classifyCommand('Get-Content f | Set-Content f', { ...PWSH, blockEmptyWrites: false }).action, 'deny');
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
  ];
  for (const cmd of gaps) assertAllow(cmd);
});

// --- 2.4.2: findings from the 2026-11-24 corpus sweep ----------------------
//
// Each case below is a *measured* behaviour, with the direction it must move.
// The sweep (62,131 real commands) is in
// docs/incidents/2026-11-24-rule-false-positive-sweep.md.

test('order: a read after the write is a read-back, not a source', () => {
  // 171 of the historical false positives were "write, then read the result to
  // report or verify it". The value cannot reach a write that already ran.
  assertAllow('Out-File -FilePath out.txt -InputObject $x; Get-Content out.txt');
  assertAllow('python x.py 2>&1 | Out-File -Encoding utf8 s/x.txt; Get-Content s/x.txt');
  assertAllow('Set-Content $f $t; $chk = Get-Content $f; if($chk.Length -lt 100){throw "short"}');
  // …but the incident itself is read-before-write and stays refused.
  assertDeny('$c=Get-Content $f; Set-Content $f $c', 'in-place-rewrite');
  assertDeny('Get-Content $f | Set-Content $f', 'in-place-rewrite');
});

test('order: a realistic scan-to-file command is a read-back', () => {
  // Verbatim from a live session (554a79ed, refused 2026-11-22 under 2.2.3). The shape
  // is ordinary: define variables, run a tool into a file, print the path, peek at the
  // head. The only read is the peek, and it comes after the write. Five such commands
  // were refused in a row, and the model reworded the same request each time.
  assertAllow([
    "$env:PYTHONIOENCODING='utf-8'",
    "$py='C:\\app\\.venv\\Scripts\\python.exe'",
    "$scan='C:\\tools\\scan_books.py'",
    "$root='D:\\comic'",
    "$out='C:\\work\\todo-list.txt'",
    '& $py $scan --root $root --list todo --limit 99999 | Out-File -FilePath $out -Encoding utf8',
    'Write-Output $out',
    'Get-Content $out -TotalCount 12',
  ].join('\n'));
});

test('order: a read that precedes the last write may have fed it', () => {
  // The mirror of the exemption above. `Set-Content f 'x'; $old = Get-Content f;
  // Set-Content f $old` is the incident with a write in front of it, so the exemption
  // must not apply: nothing in the text proves the last write ignored the read.
  assertDeny("'x' | Set-Content $f; Get-Content $f; 'y' | Set-Content $f", 'in-place-rewrite');
  assertDeny("'x' | Set-Content $f; $o = Get-Content $f; Set-Content $f $o", 'in-place-rewrite');
});

test('a copy counts whatever it is named', () => {
  // The check asks whether the old content still exists, not what the suffix proves about
  // intent. `Copy-Item $f "$f.bak"` was accepted while `"$f.tmp"` was refused — and the
  // README told the caller to use a temp file. Measured 2026-11-25.
  for (const suffix of ['.bak', '.tmp', '.new', '.orig', '.old']) {
    assertAllow(`Copy-Item $f "$f${suffix}"; $t=Get-Content $f -Raw; Set-Content $f $t`);
  }
  // A copy of the target, taken before the write, is the only thing that qualifies. Writing
  // the *new* content to a temp file and moving it over the original keeps no old bytes.
  assertDeny(`$o="$env:TEMP\\x.tmp"; $t=Get-Content $f -Raw; Set-Content $o $t; Copy-Item $o $f -Force`, 'in-place-rewrite');
  assertDeny('$t=Get-Content $f -Raw; Set-Content $f $t', 'in-place-rewrite');
});

test('a script that writes a file and reads it back is still refused', () => {
  // Conservative, and knowingly so: `open(p,'w')` truncates immediately, so "write then read"
  // and "read then write" both lose the file and the guard cannot tell them apart inside one
  // statement. The refusal no longer claims an order it cannot see — it says the command
  // reads and writes the same file, which is true either way.
  const script = [
    "$env:X='1'; & python -c @\"",
    'open(r"C:\\\\T\\\\a.png","wb").write(b)',
    'im=Image.open(r"C:\\\\T\\\\a.png")',
    'im.save(r"C:\\\\T\\\\b.png")',
    '"@',
  ].join('\n');
  const v = assertDeny(script, 'in-place-rewrite');
  assert.doesNotMatch(v.reason, /then overwrites/, 'the reason must not claim an order it cannot see');
  assert.match(v.reason, /reads and writes/, 'it should say what it can see');
});

test('the commonest refusal now names the shortest way through', () => {
  // Of the 41 `in-place-rewrite` refusals in the 6,000-command sample, 28 are a bounded
  // substitution that lacks an explicit encoding. The text offered only the copy route.
  const noEncoding = assertDeny(
    "$t=Get-Content a.md -Raw; $t=$t.Replace('a','b'); Set-Content a.md $t",
    'in-place-rewrite',
  );
  assert.match(noEncoding.reason, /-Encoding utf8/, 'the two-word fix must be named');
  // …and the same command with the encoding pinned passes, so the hint is true.
  assertAllow("$t=Get-Content a.md -Raw -Encoding utf8; $t=$t.Replace('a','b'); Set-Content a.md $t -Encoding utf8");
  // A slice refusal is a different mistake and must not carry the encoding advice.
  const slice = assertDeny(
    "$lines=Get-Content $f; $idx=(Select-String -Path $f -Pattern 'x').LineNumber; Set-Content $f $lines[0..($idx-2)]",
    'slice-risk',
  );
  assert.doesNotMatch(slice.reason, /-Encoding utf8/);
});

test('Python reads and overwrites the same file', () => {
  // The mode argument is what separates read from write; a mode-less `open()` reads.
  assertDeny('python -c "open(\'a.md\',\'w\').write(open(\'a.md\').read())"', 'in-place-rewrite');
  assertAllow('python -c "print(open(\'a.md\').read())"');
  assertAllow('python -c "open(\'b.md\',\'w\').write(\'x\')"');
  // A path built by a call is not recorded as a file name: `[^,)]+` stopped inside the call
  // and the fragment matched nothing real, turning a read-only script into a rewrite.
  assertAllow('python -c "import os; p=os.path.join(d,\'a.json\'); print(open(p, encoding=\'utf-8\').read())"');
});

test('a shell redirection on the read side counts too', () => {
  // `tr a-z A-Z < a.md > a.md` empties the file: the shell truncates the output before the
  // command reads. The head scan only knew reader *commands*, so the input side was missed.
  assertDeny('tr a-z A-Z < a.md > a.md', 'in-place-rewrite', BASH);
  assertAllow('tr a-z A-Z < a.md > b.md', BASH);
  assertAllow('cat a.md > b.md', BASH);
});

test('.NET writes participate in the order check', () => {
  // Giving .NET writes no statement index made the last-write lookup return -1,
  // which emptied the read set and let 223 historical commands through.
  assertDeny("$f='a.md'; $t=[IO.File]::ReadAllText($f); [IO.File]::WriteAllText($f,$t)", 'in-place-rewrite');
  assertDeny("$f='a.md'; $t=Get-Content $f -Raw; [IO.File]::WriteAllText($f,$t)", 'in-place-rewrite');
});

test('the same rewrite in JavaScript is guarded too', () => {
  // The hazard does not care which language spells it: reading a file and writing it back
  // replaces the only copy exactly as `Get-Content f | Set-Content f` does. Neither `fs`
  // pattern was known, so a `node -e` one-liner was unguarded while the PowerShell spelling
  // of the same act was refused. Measured 2026-11-25.
  assertDeny(
    `node -e "const fs=require('fs'); const s=fs.readFileSync('a.md','utf8'); fs.writeFileSync('a.md', s);"`,
    'in-place-rewrite',
  );
  assertDeny(
    `node -e "const fs=require('fs'); let s=fs.readFileSync(p); s=s.replace(/x/g,'y'); fs.writeFileSync(p, s);"`,
    'in-place-rewrite',
  );
  // Writing somewhere else, or only writing, is not this rule.
  assertAllow(`node -e "const fs=require('fs'); fs.writeFileSync('out.md', 'hi');"`);
  assertAllow(`node -e "const fs=require('fs'); const s=fs.readFileSync('a.md'); console.log(s);"`);
});

test('a read folded into the write statement is still a read', () => {
  // The most compact spelling of the incident: one line, no separate Get-Content.
  // Four variants were all allowed until 2.4.2.
  assertDeny('$f="a.md"; Set-Content $f (Get-Content $f | Select-Object -First 10)', 'in-place-rewrite');
  assertDeny('$f="a.md"; Set-Content $f ((Get-Content $f)[0..2])', 'in-place-rewrite');
  assertDeny('$f="a.md"; Set-Content $f (Get-Content $f | Where-Object { $_ -like "*keep*" })', 'in-place-rewrite');
  assertDeny('Set-Content notes.md (Get-Content notes.md | Select-Object -First 3)', 'in-place-rewrite');
  assertDeny('Select-String -Path a.md -Pattern "x" | Set-Content a.md', 'in-place-rewrite');
});

test('repetition makes textual order untrustworthy', () => {
  // A read after a write may feed the *next* iteration's write, so the order
  // exemption must not apply inside a loop. `%` is ForEach-Object's alias and is the
  // commonest spelling — it was missing from the first gate.
  assertDeny('$fs=@("a","b"); $fs | % { Set-Content $_ $c; $c = Get-Content $_ }', 'in-place-rewrite');
  assertDeny('do { Set-Content $f $c; $c = Get-Content $f } until ($true)', 'in-place-rewrite');
  // …but a loop keyword inside a string is not a shell loop.
  assertAllow('python -c "for i,l in enumerate(open(\'x\')): print(i)"');
});

test('a backup only counts when it is a real copy of the target, made first', () => {
  // Allowed: the documented recipe.
  assertAllow("$f='a.md'; Copy-Item -LiteralPath $f -Destination \"$f.bak-20261125\"; $t=Get-Content $f -Raw; Set-Content $f $t");
  assertAllow("sed -i.bak 's/a/b/' notes.md", BASH);
  // Refused: markers that are not copies.
  assertDeny("$f='a.md'; $t=Get-Content $f -Raw; Set-Content $f $t  # no .bak needed here", 'in-place-rewrite');
  assertDeny("$f='a.bak'; $t=Get-Content $f -Raw; Set-Content $f $t", 'in-place-rewrite');
  assertDeny("$note='.bak is for wimps'; $f=Get-Content a.md -Raw; Set-Content a.md $f", 'in-place-rewrite');
  // Refused: a backup taken after the overwrite preserves the destroyed content.
  assertDeny("$f='a.md'; $t=Get-Content $f -Raw; Set-Content $f 'new'; Copy-Item $f \"$f.bak\"", 'in-place-rewrite');
});

test('a temp file holding the NEW content is not a backup', () => {
  // The deny message asks for a copy of the original; verifying the output does not
  // make the input recoverable if the transformation was wrong.
  assertDeny([
    "$f='a.md'",
    '$t=[System.IO.File]::ReadAllText($f)',
    "$new=$t.Replace('old','new')",
    "$tmp=$f+'.tmp'",
    '[System.IO.File]::WriteAllText($tmp,$new)',
    'Copy-Item -LiteralPath $tmp -Destination $f -Force',
  ].join('; '), 'in-place-rewrite');
});

test('a bounded substitution with the codec pinned is the edit tool', () => {
  // Both encodings stated on both sides: the file cannot be re-encoded, and content
  // outside the matched substring is untouched.
  assertAllow("$f='a.md'; $t=Get-Content $f -Raw -Encoding utf8; $t=$t.Replace('a','b'); Set-Content $f $t -Encoding utf8");
  assertAllow("$f='a.mjs'; (Get-Content $f -Raw -Encoding utf8) -replace 'a\\.txt','b.txt' | Set-Content $f -Encoding utf8");
  // Missing the read-side codec is the mojibake hazard: a GBK file read as UTF-8 and
  // written back destroys every non-ASCII character even when the needle is ASCII.
  assertDeny("$f='a.mjs'; (Get-Content $f -Raw) -replace 'a\\.txt','b.txt' | Set-Content $f -Encoding utf8", 'in-place-rewrite');
  // A document-wide regex is a whole-content replacement, not a substitution.
  assertDeny("$f='a.md'; $t=Get-Content $f -Raw -Encoding utf8; $t=$t -replace '(?s)^.*$','x'; Set-Content $f $t -Encoding utf8", 'in-place-rewrite');
  // …and neither is a substitution applied to a slice.
  assertDeny("$f='a.md'; $t=Get-Content $f -Raw -Encoding utf8; $t=$t.Replace('a','b'); Set-Content $f ($t -split [char]10)[0..2] -Encoding utf8", 'in-place-rewrite');
});

test('content destroyed with no slice token stays refused', () => {
  // These are why the rule is not a "discard-token list": none of them contains
  // `[a..b]`, `-First`, or `Select-Object`, and all of them rebuild the file.
  assertDeny('$l = Get-Content $f; $l = $l | Where-Object { -not ($_ -like "*例题*") }; Set-Content $f $l', 'in-place-rewrite');
  assertDeny('$L = Get-Content $f; $out=@(); for($i=0;$i -lt $L.Count;$i++){ if($L[$i] -match "^### P\\d+"){continue}; $out += $L[$i] }; Set-Content $f $out', 'in-place-rewrite');
  assertDeny('$l = Get-Content $f; $l = $l | Where-Object { $_ -match "^## " }; Set-Content $f $l', 'in-place-rewrite');
  assertDeny('$t = Get-Content $f -Raw; $t = $t -replace "(?s)^.*$","x"; Set-Content $f $t', 'in-place-rewrite');
});

