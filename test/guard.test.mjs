/**
 * Guard classification tests.
 *
 * Run: node --test test/guard.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand } from '../lib/guard.js';

const OPTS = { forbidEmptyRecycleBin: true, forbidWipe: true, blockScriptDeletes: true };
const BASH = { ...OPTS, dialect: 'bash' };
const PWSH = { ...OPTS, dialect: 'pwsh' };

/** Assert a command classifies as a rewrite with exactly these targets. */
function assertRewrite(command, targets) {
  const v = classifyCommand(command, OPTS);
  assert.equal(v.action, 'rewrite', `expected rewrite for: ${command} (got ${v.action}${v.reason ? ': ' + v.reason : ''})`);
  assert.deepEqual(v.targets.sort(), targets.sort(), `targets mismatch for: ${command}`);
}

/** Assert a command is denied, optionally with a given kind. */
function assertDeny(command, kind) {
  const v = classifyCommand(command, OPTS);
  assert.equal(v.action, 'deny', `expected deny for: ${command} (got ${v.action})`);
  if (kind !== undefined) assert.equal(v.kind, kind, `kind mismatch for: ${command}`);
}

/** Assert a command is left alone. */
function assertAllow(command) {
  const v = classifyCommand(command, OPTS);
  assert.equal(v.action, 'allow', `expected allow for: ${command} (got ${v.action}: ${v.targets ?? v.reason})`);
}

test('powerShell delete verbs are rewritten', () => {
  assertRewrite('Remove-Item C:\\tmp\\a.txt', ['C:\\tmp\\a.txt']);
  assertRewrite('Remove-Item -Recurse -Force C:\\tmp\\dir', ['C:\\tmp\\dir']);
  assertRewrite('Remove-Item -Path C:\\tmp\\a.txt', ['C:\\tmp\\a.txt']);
  assertRewrite('ri C:\\tmp\\a.txt', ['C:\\tmp\\a.txt']);
});

test('cmd and posix delete verbs are rewritten', () => {
  assertRewrite('del C:\\tmp\\a.txt', ['C:\\tmp\\a.txt']);
  assertRewrite('erase C:\\tmp\\a.txt', ['C:\\tmp\\a.txt']);
  assertRewrite('rm /tmp/x.txt', ['/tmp/x.txt']);
  assertRewrite('rm -rf /tmp/x', ['/tmp/x']);
  assertRewrite('unlink /tmp/x', ['/tmp/x']);
  assertRewrite('rmdir C:\\tmp\\dir', ['C:\\tmp\\dir']);
  assertRewrite('rd C:\\tmp\\dir', ['C:\\tmp\\dir']);
});

test('multiple targets and multiple statements are collected', () => {
  assertRewrite('Remove-Item C:\\a.txt, C:\\b.txt', ['C:\\a.txt', 'C:\\b.txt']);
  assertRewrite('del C:\\a.txt; del C:\\b.txt', ['C:\\a.txt', 'C:\\b.txt']);
  assertRewrite('Remove-Item C:\\a.txt && Remove-Item C:\\b.txt', ['C:\\a.txt', 'C:\\b.txt']);
});

test('quoted paths unwrap to bare operands', () => {
  assertRewrite('Remove-Item "C:\\Program Data\\x.txt"', ['C:\\Program Data\\x.txt']);
  assertRewrite("Remove-Item 'C:\\tmp\\a.txt'", ['C:\\tmp\\a.txt']);
});

test('non-delete commands are untouched', () => {
  assertAllow('Get-ChildItem C:\\tmp');
  assertAllow('Get-Content form.txt');
  assertAllow('Write-Output "remove me later"');
  assertAllow('git status');
  assertAllow('npm run build');
  assertAllow('echo "rm is a command"');
});

test('a delete verb as a non-command token is not a false positive', () => {
  // The word appears, but not in command position.
  assertAllow('$rm = 1');
  assertAllow('Get-Item remove-item.txt');
  assertAllow('Select-String -Pattern "del" README.md');
});

test('the recycle bin itself is protected', () => {
  assertDeny('Clear-RecycleBin', 'empty-recycle');
  assertDeny('Clear-RecycleBin -Force', 'empty-recycle');
  assertDeny('Remove-Item C:\\$Recycle.Bin\\* -Recurse -Force', 'empty-recycle');
  assertDeny('rd C:\\$Recycle.Bin', 'empty-recycle');
});

test('permanent-erase tooling is denied', () => {
  assertDeny('sdelete -p 3 C:\\secret.txt', 'wipe');
  assertDeny('shred -u /tmp/secret', 'wipe');
  assertDeny('srm /tmp/secret', 'wipe');
  assertDeny('cipher /w:C:', 'wipe');
  assertDeny('format D:', 'wipe');
});

test('opaque constructs that hide targets are denied', () => {
  assertDeny('Remove-Item $(Get-Content list.txt)', 'opaque');
  assertDeny('Remove-Item `whoami`.txt', 'opaque');
  assertDeny('Get-ChildItem C:\\tmp | Remove-Item', 'opaque');
  assertDeny('Remove-Item -Recurse C:\\tmp\\*', 'opaque');
  assertDeny('rm -rf --no-preserve-root /', 'opaque');
});

test('script-file and inline-string deletes are denied', () => {
  assertDeny('node -e "require(\'fs\').rmSync(\'/tmp/x\')"', 'script');
  assertDeny('bash -c "rm -rf /tmp/x"', 'script');
  assertDeny('pwsh -Command "Remove-Item C:\\x"', 'script');
  assertDeny('echo "Remove-Item C:\\x" > clean.ps1', 'script');
});

test('dangerous absolute targets are denied', () => {
  assertDeny('Remove-Item C:\\ -Recurse -Force', 'forbidden-target');
  assertDeny('rm -rf /', 'forbidden-target');
  assertDeny('Remove-Item C:\\Windows -Recurse -Force', 'forbidden-target');
  assertDeny('Remove-Item "C:\\Program Files" -Recurse', 'forbidden-target');
  assertDeny('Remove-Item ..\\..\\important.txt', 'forbidden-target');
});

test('bare glob deletes are denied rather than guessed', () => {
  const v = classifyCommand('Remove-Item * -Force', OPTS);
  assert.equal(v.action, 'deny');
  assert.equal(v.kind, 'forbidden-target');
});

test('empty and non-string input is allowed through untouched', () => {
  assert.equal(classifyCommand('', OPTS).action, 'allow');
  assert.equal(classifyCommand('   ', OPTS).action, 'allow');
  assert.equal(classifyCommand(undefined, OPTS).action, 'allow');
});

test('policy switches turn rules off', () => {
  const relaxed = { forbidEmptyRecycleBin: false, forbidWipe: false, blockScriptDeletes: false };
  assert.equal(classifyCommand('Clear-RecycleBin', relaxed).action, 'allow');
  // With the wipe rule off, `shred` falls through to the ordinary delete path and
  // is still redirected to the Recycle Bin rather than allowed to run.
  const shred = classifyCommand('shred -u /tmp/x', relaxed);
  assert.equal(shred.action, 'rewrite');
  assert.deepEqual(shred.targets, ['/tmp/x']);
  // The rewrite rule is not switchable: a plain delete is still redirected to
  // the Recycle Bin even when every optional rule is off.
  const v = classifyCommand('rm /tmp/x', relaxed);
  assert.equal(v.action, 'rewrite');
  assert.deepEqual(v.targets, ['/tmp/x']);
});

test('a normal delete still routes to rewrite when only script blocking is off', () => {
  const v = classifyCommand('Remove-Item C:\\tmp\\a.txt', {
    forbidEmptyRecycleBin: true,
    forbidWipe: true,
    blockScriptDeletes: false,
  });
  assert.equal(v.action, 'rewrite');
  assert.deepEqual(v.targets, ['C:\\tmp\\a.txt']);
});

// --- dialect scoping -------------------------------------------------------
//
// `$( … )` is command substitution in PowerShell but ordinary syntax in bash.
// Applying the PowerShell rule to bash refuses nearly every real command, so
// the rule must be scoped. These tests pin that behaviour in both directions.

test('$( … ) is denied under pwsh (command substitution)', () => {
  const v = classifyCommand('Remove-Item $(Get-Content list.txt)', PWSH);
  assert.equal(v.action, 'deny');
  assert.equal(v.kind, 'opaque');
});

test('$( … ) is NOT opaque under bash when it is not the delete target', () => {
  // The classic false positive: bash command substitution in an unrelated part
  // of the command. This must pass through untouched.
  for (const cmd of [
    'echo "cwd=$(pwd)"',
    'ls $(git rev-parse --show-toplevel)',
    'for f in $(ls *.txt); do echo "$f"; done',
    'echo "$(date +%Y)"',
  ]) {
    const v = classifyCommand(cmd, BASH);
    assert.equal(v.action, 'allow', `bash must allow: ${cmd} (got ${v.action}: ${v.reason ?? ''})`);
  }
});

test('a real bash delete using $( … ) is still denied, not waved through', () => {
  // Scoping the rule must not open a hole: a delete whose target comes from
  // command substitution is still unprovable and must be refused.
  const v = classifyCommand('rm -rf $(cat list.txt)', BASH);
  assert.equal(v.action, 'deny');
  assert.equal(v.kind, 'opaque');
  assert.match(v.reason, /substitution/i);
});

test('substituted delete targets are refused in both dialects', () => {
  // The operand itself is a substitution: its value only exists at run time,
  // so it must never be treated as a literal path to recycle.
  const cases = [
    'rm -rf $(cat list.txt)',
    'rm -f `cat list.txt`',
    'rm -rf $TARGET',
    'rm -rf ${TARGET_DIR}',
  ];
  for (const cmd of cases) {
    for (const opts of [PWSH, BASH]) {
      const v = classifyCommand(cmd, opts);
      assert.equal(v.action, 'deny', `${opts.dialect} must deny: ${cmd}`);
      assert.equal(v.kind, 'opaque', `${opts.dialect} kind for: ${cmd}`);
    }
  }
});

test('xargs-driven deletes are refused (target set unknowable)', () => {
  for (const cmd of [
    'find . -name "*.tmp" | xargs rm -f',
    'find . -name "*.tmp" | xargs -I{} rm -f {}',
    'xargs rm',
  ]) {
    const v = classifyCommand(cmd, BASH);
    assert.equal(v.action, 'deny', `must deny: ${cmd}`);
    assert.equal(v.kind, 'opaque', `kind for: ${cmd}`);
  }
});

test('backtick substitution stays denied in both dialects', () => {
  // Backticks are command substitution in both shells.
  for (const opts of [PWSH, BASH]) {
    const v = classifyCommand('Remove-Item `whoami`.txt', opts);
    assert.equal(v.action, 'deny', `backticks must be denied for dialect ${opts.dialect}`);
  }
});

test('plain bash deletes are rewritten regardless of substitution scoping', () => {
  // A relative operand: `dialect: 'bash'` only changes `$( … )` opacity, and
  // (since 1.0.8) translates drive-mapped POSIX paths. `/tmp/x` is deliberately
  // no longer a rewrite — `/tmp` is an MSYS mount point with no provable Windows
  // target, so it is refused (see the Git Bash path tests).
  const v = classifyCommand('rm -rf build', BASH);
  assert.equal(v.action, 'rewrite');
  assert.deepEqual(v.targets, ['build']);
});

test('dialect defaults to pwsh when unspecified', () => {
  // Backwards compatibility: existing callers that omit `dialect` keep the
  // original PowerShell behaviour.
  const v = classifyCommand('Remove-Item $(Get-Content list.txt)', OPTS);
  assert.equal(v.action, 'deny');
  assert.equal(v.kind, 'opaque');
});

test('benign xargs pipelines are not false positives', () => {
  // The xargs rule must only fire when the wrapped verb deletes.
  for (const cmd of [
    'ls *.txt | xargs wc -l',
    'find . -type f | xargs grep -l foo',
  ]) {
    assertAllow(cmd);
  }
});

test('hidden delete under bash substitution is caught', () => {
  // A pipeline delete is opaque in both dialects.
  const v = classifyCommand('find . -name "*.tmp" | xargs rm -f', BASH);
  assert.equal(v.action, 'deny');
});

// --- script blocks ---------------------------------------------------------
//
// Regression: on 2026-10-18 a real `Remove-Item` ran unguarded because it was
// wrapped in a block. `if (Test-Path $p) { Remove-Item $p -Force }` was allowed
// while the same delete across three lines was denied — the newline happened to
// be a statement separator and the brace did not. Every form below must be
// seen; whether it ends as a redirect or a refusal is a separate question,
// decided by whether the operands can be proven.

test('a delete inside a script block is seen, not skipped', () => {
  const forms = [
    'if (Test-Path C:\\tmp\\x.txt) { Remove-Item C:\\tmp\\x.txt -Force }',
    'if($true){Remove-Item C:\\tmp\\x.txt}',
    '& { Remove-Item C:\\tmp\\x.txt }',
    '. { Remove-Item C:\\tmp\\x.txt }',
    'try { Remove-Item C:\\tmp\\x.txt } catch { }',
    '(Remove-Item C:\\tmp\\x.txt)',
    '$x = Remove-Item C:\\tmp\\x.txt',
    'Start-Job { Remove-Item C:\\tmp\\x.txt }',
  ];
  for (const cmd of forms) {
    const v = classifyCommand(cmd, PWSH);
    assert.notEqual(v.action, 'allow', `block-wrapped delete must not be allowed: ${cmd}`);
  }
});

test('a block-wrapped delete with a literal target is redirected', () => {
  for (const cmd of [
    'if (Test-Path C:\\tmp\\x.txt) { Remove-Item C:\\tmp\\x.txt -Force }',
    'if($true){Remove-Item C:\\tmp\\x.txt}',
    '& { Remove-Item C:\\tmp\\x.txt }',
  ]) {
    assertRewrite(cmd, ['C:\\tmp\\x.txt']);
  }
});

test('a block-wrapped delete over a variable is refused, not guessed', () => {
  // `$out` has no provable value, so the redirect would name a literal "$out".
  for (const cmd of [
    'if (Test-Path $out) { Remove-Item $out -Force }',
    'foreach ($f in $fs) { Remove-Item $f }',
    'Get-ChildItem C:\\tmp | ForEach-Object { Remove-Item $_.FullName }',
  ]) {
    const v = classifyCommand(cmd, PWSH);
    assert.equal(v.action, 'deny', `must be denied: ${cmd}`);
    assert.equal(v.kind, 'opaque', `kind for: ${cmd}`);
  }
});

test('nested blocks still reach the delete', () => {
  const v = classifyCommand('if ($a) { foreach ($f in $fs) { Remove-Item $f } }', PWSH);
  assert.equal(v.action, 'deny');
});

test('${name} is a variable, not a block boundary', () => {
  // Splitting inside `${TARGET_DIR}` would leave a literal `$` as the operand.
  const v = classifyCommand('rm -rf ${TARGET_DIR}', BASH);
  assert.equal(v.action, 'deny');
  assert.equal(v.kind, 'opaque');
});

// --- erasing constructs with no shell verb ---------------------------------

test('API-level erases are denied', () => {
  for (const cmd of [
    "[System.IO.File]::Delete('C:\\tmp\\x.txt')",
    "[System.IO.Directory]::Delete('C:\\tmp\\d', $true)",
    'Invoke-Expression "Remove-Item C:\\tmp\\x.txt"',
    'iex "Remove-Item C:\\tmp\\x.txt"',
    'cmd /c del /q C:\\tmp\\x.txt',
    'robocopy C:\\empty C:\\target /MIR',
    'robocopy C:\\src C:\\dst /PURGE',
  ]) {
    const v = classifyCommand(cmd, PWSH);
    assert.equal(v.action, 'deny', `must be denied: ${cmd}`);
    assert.equal(v.kind, 'erase-api', `kind for: ${cmd}`);
  }
});

test('find -delete is denied under bash only', () => {
  const v = classifyCommand('find . -name "*.tmp" -delete', BASH);
  assert.equal(v.action, 'deny');
  assert.equal(v.kind, 'erase-api');
  // The same text under pwsh is not a delete; `find` there is the alias for
  // Select-String, where `-delete` is not a parameter anyone writes.
  assertAllow('find . -name "*.tmp" -delete');
});

test('a splatted operand array is refused', () => {
  const v = classifyCommand('Remove-Item @targets', PWSH);
  assert.equal(v.action, 'deny');
  assert.equal(v.kind, 'opaque');
});

test('writing a script file containing a delete is refused', () => {
  for (const cmd of [
    'echo "Remove-Item C:\\x" > clean.ps1',
    '"Remove-Item C:\\x" | Out-File clean.ps1',
  ]) {
    const v = classifyCommand(cmd, PWSH);
    assert.equal(v.action, 'deny', `must be denied: ${cmd}`);
    assert.equal(v.kind, 'script');
  }
});

// --- false positives that used to block read-only work ---------------------
//
// Regression: the old script rule matched a shell delete verb anywhere in the
// text, so these were refused. They delete nothing.

test('read-only work mentioning a delete is not blocked', () => {
  for (const cmd of [
    // Python's own `del` statement, inside an inline body.
    'python -c "d={}\ndel d[1]"',
    // `re.sub(` used to match a bare `rm\(` pattern.
    'python -c "import re; re.sub(r\'[()]\', \'\', x)"',
    // `Get-ChildItem -Recurse -File` used to look like pwsh's `-File` flag.
    '(Get-ChildItem $out -Recurse -File | Measure-Object).Count',
    // A benign inline body with no erasing call.
    'python -c "print(1+1)"',
    'bash -c "ls -la"',
    'node -e "console.log(1)"',
  ]) {
    assertAllow(cmd);
  }
});

test('flag values are not mistaken for delete targets', () => {
  // `-ErrorAction SilentlyContinue` used to produce a redirect naming
  // "SilentlyContinue" as a path to recycle.
  assertRewrite('Remove-Item C:\\tmp\\x.txt -Force -ErrorAction SilentlyContinue', ['C:\\tmp\\x.txt']);
  assertRewrite('Remove-Item -Path C:\\tmp\\x.txt -Filter *.log', ['C:\\tmp\\x.txt']);
});

// --- 1.0.4: structure, not substring ---------------------------------------
//
// Regression, reported from a live session: reading a .bat file to check its
// byte count was refused as "a System.IO delete API". The rule matched the type
// reference `[System.IO.File]` instead of the erase *call*, so every read-only
// System.IO call in the namespace was denied. Two more rules had the same
// defect: a wipe program name and `Clear-RecycleBin` matched anywhere in the
// line, including inside a quoted pattern or a file name.

test('System.IO type references are not delete calls', () => {
  for (const cmd of [
    // The reported command, verbatim (abbreviated path, same shape).
    "$b=[System.IO.File]::ReadAllBytes('C:\\x.bat'); \"bytes=$($b.Count)\""
      + '; "crlf=$((Select-String -Path \'C:\\x.bat\' -Pattern "`r`n" -AllMatches).Matches.Count)"',
    "[System.IO.File]::ReadAllText('C:\\x.txt')",
    "[System.IO.File]::Exists('C:\\x.txt')",
    "[System.IO.Directory]::Exists('C:\\tmp')",
    "[System.IO.Directory]::GetFiles('C:\\tmp')",
    "[System.IO.File]::GetLastWriteTime('C:\\x.txt')",
    "[System.IO.File]::WriteAllText('C:\\x.txt','hi')",
    "[System.IO.File]::Copy('C:\\a','C:\\b')",
    "[System.IO.File]::Move('C:\\a','C:\\b')",
  ]) {
    assertAllow(cmd);
  }
});

test('the System.IO erase calls are still denied, in every spelling', () => {
  for (const cmd of [
    "[System.IO.File]::Delete('C:\\tmp\\x.txt')",
    "[System.IO.Directory]::Delete('C:\\tmp\\d', $true)",
    // The type parked in a variable is the same call, and the type literal is
    // no longer what convicts it — the `::Delete(` shape is.
    '$f = [System.IO.File]; $f::Delete(\'C:\\tmp\\x.txt\')',
    '[System.IO.FileInfo]::new(\'C:\\tmp\\x.txt\').Delete()',
    '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(\'C:\\tmp\\x.txt\')',
    "[System.IO.DirectoryInfo]::new('C:\\tmp\\d').Delete($true)",
  ]) {
    const v = classifyCommand(cmd, PWSH);
    assert.equal(v.action, 'deny', `must be denied: ${cmd}`);
    assert.equal(v.kind, 'erase-api', `kind for: ${cmd}`);
  }
});

test('a wipe program name is matched where a program runs, not anywhere', () => {
  for (const cmd of [
    'Get-Content C:\\logs\\sdelete.log',
    'Get-Content C:\\tools\\shred.exe',
    'Select-String -Path notes.md -Pattern "wipe"',
    'Get-ChildItem C:\\tmp -Filter *srm*',
  ]) {
    assertAllow(cmd);
  }
  // Same, under bash: reading or grepping for the word is not running it.
  for (const cmd of ['grep -n "shred" *.md', 'cat /tmp/wipe.log']) {
    const v = classifyCommand(cmd, BASH);
    assert.equal(v.action, 'allow', `must be allowed: ${cmd} (got ${v.action})`);
  }
});

test('a wipe program is still denied in program position', () => {
  for (const cmd of [
    'sdelete -p 3 C:\\secret.txt',
    'sdelete64 -p 3 C:\\secret.txt',
    '"C:\\tools\\sdelete64.exe" -p 3 C:\\secret.txt',
    'Start-Process -FilePath shred -ArgumentList "-u /tmp/x"',
    'cmd /c sdelete -p 3 C:\\secret.txt',
    'Get-ChildItem C:\\tmp | ForEach-Object { Start-Process shred $_ }',
    // The body handed to a child shell is shell text, so program position moves
    // inside the string.
    'bash -c "shred -u /tmp/x"',
    'pwsh -Command "srm /tmp/x"',
  ]) {
    const v = classifyCommand(cmd, cmd.startsWith('bash') ? BASH : PWSH);
    assert.equal(v.action, 'deny', `must be denied: ${cmd}`);
    assert.equal(v.kind, 'wipe', `kind for: ${cmd}`);
  }
});

test('Clear-RecycleBin is matched in command position, not in prose', () => {
  assertAllow('Select-String -Path README.md -Pattern "Clear-RecycleBin"');
  assertAllow('git commit -m "document Clear-RecycleBin"');
  assertDeny('Clear-RecycleBin', 'empty-recycle');
  assertDeny('Clear-RecycleBin -DriveLetter C -Force', 'empty-recycle');
  assertDeny('& { Clear-RecycleBin }', 'empty-recycle');
});

// --- 1.0.8: Git Bash paths -------------------------------------------------
//
// Git Bash users write `/c/tmp/x`, `/cygdrive/c/...` and `~`. Handing those to
// `file_trash` unchanged makes Node's Windows resolver read them as
// `<cwd drive>:\c\tmp\x` — a different location (or nothing). The translation
// happens in the classifier because it is the only place that knows the dialect:
// `pwsh` reads the same string as drive-relative.

test('Git Bash paths are translated to the Windows path they denote', () => {
  const msys = classifyCommand('rm -rf /c/tmp/build', BASH);
  assert.equal(msys.action, 'rewrite');
  assert.deepEqual(msys.targets, ['C:\\tmp\\build']);

  const cygwin = classifyCommand('rm -rf /cygdrive/f/Workspace/out', BASH);
  assert.deepEqual(cygwin.targets, ['F:\\Workspace\\out']);

  // The same text under pwsh is drive-relative, and translation would be wrong.
  const pwsh = classifyCommand('rm -rf /c/tmp/build', PWSH);
  assert.deepEqual(pwsh.targets, ['/c/tmp/build']);
});

test('unmappable POSIX targets are refused, not guessed', () => {
  for (const cmd of ['rm -rf /tmp/x', 'rm -rf ~', 'rm -rf ~/notes.txt', 'rm -rf /usr/local/lib']) {
    const v = classifyCommand(cmd, BASH);
    assert.equal(v.action, 'deny', `must be denied: ${cmd}`);
    assert.equal(v.kind, 'opaque', `kind for: ${cmd}`);
  }
  // `/` stays a forbidden target so the message names the right thing.
  const root = classifyCommand('rm -rf /', BASH);
  assert.equal(root.action, 'deny');
  assert.equal(root.kind, 'forbidden-target');
});


//
// 1.0.6 blocked `Clear-RecycleBin` only as literal text at the start of a
// statement. Everything below was allowed, and each one empties the bin without
// a prompt except the last two groups (which delete the bin's store directly).
// Note on abbreviations: `Clear-R` / `Clear-Recy` do NOT resolve — PowerShell
// rejects abbreviated cmdlet names (measured: `Get-Command Clear-R` and invoking
// `Get-Loc` both fail with CommandNotFoundException), so no rule is needed.

test('every spelling that empties the bin is denied', () => {
  const encoded = Buffer.from('Clear-RecycleBin -Force', 'utf16le').toString('base64');
  for (const cmd of [
    'Clear-RecycleBin',
    'Clear-RecycleBin -DriveLetter C -Force',
    '& "Clear-RecycleBin"',
    'pwsh -Command "Clear-RecycleBin -Force"',
    'powershell -c "Clear-RecycleBin -Force"',
    "Start-Process powershell -ArgumentList '-NoProfile','-Command','Clear-RecycleBin -Force'",
    `pwsh -NoProfile -EncodedCommand ${encoded}`,
    "Add-Type -TypeDefinition 'public static class N { [System.Runtime.InteropServices.DllImport(\"shell32.dll\", CharSet = CharSet.Unicode)] public static extern int SHEmptyRecycleBin(IntPtr h, string p, uint f); }'",
    "(New-Object -ComObject Shell.Application).Namespace(10).Items() | ForEach-Object { $_.InvokeVerb('delete') }",
    "$s = New-Object -ComObject Shell.Application; $s.Namespace(0xa).Items() | ForEach-Object { $_.InvokeVerb('DELETE') }",
    '$s = New-Object -ComObject Shell.Application; foreach ($i in $s.Namespace(10).Items()) { $i.Verbs() | ForEach-Object { $_.DoIt() } }',
    "Remove-Item 'C:\\$Recycle.Bin\\*' -Recurse -Force",
    'rd /s /q C:\\$Recycle.Bin',
    "[System.IO.Directory]::Delete('C:\\$Recycle.Bin\\S-1-5-21-1-2-3-1001', $true)",
  ]) {
    const v = classifyCommand(cmd, PWSH);
    assert.equal(v.action, 'deny', `must be denied: ${cmd}`);
    assert.equal(v.kind, v.kind === 'erase-api' ? 'erase-api' : 'empty-recycle', `kind for: ${cmd}`);
  }
});

test('reading the bin, or restoring out of it, is not blocked', () => {
  // The sanctioned recovery path is $I metadata + Move-Item; driving the bin's
  // own shell verbs is refused above precisely because that is how it is emptied.
  for (const cmd of [
    'Select-String -Path README.md -Pattern "Clear-RecycleBin"',
    'git commit -m "document Clear-RecycleBin"',
    '$s = New-Object -ComObject Shell.Application; $s.Namespace(10).Items() | Measure-Object',
    "$bin='F:\\$RECYCLE.BIN\\S-1-5-21-1-2-3-1001'; Get-ChildItem -LiteralPath $bin -Filter '$I*' -Force",
    "Move-Item -LiteralPath 'F:\\$RECYCLE.BIN\\S-1-5-21-1-2-3-1001\\$RABC.txt' -Destination 'F:\\tmp\\x.txt'",
    'trash_status',
  ]) {
    assertAllow(cmd);
  }
});

test('a delete hidden in an -EncodedCommand body is still judged', () => {
  const encoded = Buffer.from('Remove-Item C:\\tmp\\x.txt -Force', 'utf16le').toString('base64');
  const v = classifyCommand(`pwsh -NoProfile -EncodedCommand ${encoded}`, PWSH);
  assert.equal(v.action, 'rewrite', `expected rewrite, got ${v.action}/${v.kind ?? '-'}`);
  assert.deepEqual(v.targets, ['C:\\tmp\\x.txt']);
});

// --- evidence must stay local to its statement ------------------------------
//
// Regression found by a live control probe right after 1.0.2 was installed: a
// benign `python -c "…del d['a']…"` was refused as soon as a *different*
// statement in the same command mentioned `bash`. One statement's words were
// convicting another statement's work. The shell-inline rule is now judged per
// statement, so the evidence cannot leak across a `;`.

test('one statement cannot convict another', () => {
  for (const cmd of [
    'python -c "d={\'a\':1}; del d[\'a\']" ; bash -c "echo ok"',
    'python -c "d={\'a\':1}; del d[\'a\']" ; node -e "console.log(1)"',
    '(Get-ChildItem $out -Recurse -File | Measure-Object).Count ; bash -c "ls"',
  ]) {
    assertAllow(cmd);
  }
});

test('a multi-line inline body is still caught', () => {
  // The interpreter is on line 1 and the erase call several lines later, so the
  // programmatic-erase rule is deliberately judged across the whole command.
  const cmd = "python -c @'\nimport shutil\nshutil.rmtree(\"/tmp/d\")\n'@";
  const v = classifyCommand(cmd, PWSH);
  assert.equal(v.action, 'deny');
  assert.equal(v.kind, 'script');
});

test('a piped script write is still caught', () => {
  // The pipe is a statement separator, so the delete text and the write target
  // land in different statements; the write rule is judged across the command.
  const v = classifyCommand('"Remove-Item C:\\x" | Out-File clean.ps1', PWSH);
  assert.equal(v.action, 'deny');
  assert.equal(v.kind, 'script');
});


