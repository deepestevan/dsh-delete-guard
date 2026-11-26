/**
 * Layer ⑬: the escape shapes found by review, each pinned so it cannot reopen.
 *
 * Every case here was measured as an escape on 2026-11-25 — a command that ran a
 * permanent erase while the guard said nothing. The pairs matter as much as the
 * refusals: for each shape there is a near neighbour that must keep working, because
 * the fix for "one flag defeats the rule" is easy to over-apply into "no launcher or
 * interpreter may ever appear".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyCommand } from '../lib/guard.js';

const DOLLAR = String.fromCharCode(36);

/**
 * Classify and reduce to a comparable label.
 * @param command - shell text.
 * @param dialect - 'pwsh' or 'bash'.
 * @returns 'allow' or `action/kind`.
 */
function verdict(command, dialect = 'pwsh') {
  const v = classifyCommand(command, { dialect });
  return v.action === 'allow' ? 'allow' : `${v.action}/${v.kind}`;
}

/**
 * The reason text for a refused command.
 * @param command - shell text.
 * @returns the first line of the reason.
 */
function reason(command) {
  return (classifyCommand(command, { dialect: 'pwsh' }).reason ?? '').split('\n')[0];
}

// ---------------------------------------------------------------------------
// Launchers: a switch of the launcher's own is not a way past the payload
// ---------------------------------------------------------------------------

test('wipe programs stay visible behind any number of launcher switches', () => {
  for (const command of [
    'cmd /c sdelete C:\\secret.txt',
    'cmd /d /c sdelete C:\\secret.txt',
    'cmd /d /x /c sdelete C:\\secret.txt',
    'cmd.exe /d /x /c shred /tmp/x',
    'Start-Process -FilePath shred -ArgumentList "-u /tmp/x"',
    'Start-Process -WindowStyle Hidden -FilePath sdelete -ArgumentList "-p 3 C:\\secret"',
    'Start-Process -WindowStyle Hidden -PassThru -FilePath shred -ArgumentList "-u /tmp/x"',
    'Start-Process -FilePath cmd.exe -ArgumentList "/c","sdelete C:\\secret"',
  ]) {
    assert.equal(verdict(command), 'deny/wipe', `launcher payload not seen: ${command}`);
  }
});

test('cmd /d /c hands a delete to cmd.exe like cmd /c does', () => {
  for (const command of [
    'cmd /c del C:\\x\\a.txt',
    'cmd /d /c del C:\\x\\a.txt',
    'cmd /d /x /c del C:\\x\\a.txt',
    'cmd /e:on /v:off /c rd /s /q C:\\x\\d',
  ]) {
    assert.equal(verdict(command), 'deny/erase-api', `cmd switch slipped past: ${command}`);
  }
});

test('a launcher that runs no wipe program is still allowed', () => {
  // The fix must not turn "starts with cmd" into a refusal.
  for (const command of [
    'cmd /c dir',
    'cmd /c echo hello',
    'cmd /d /c type notes.txt',
    'Start-Process notepad',
    'Start-Process -FilePath code -ArgumentList "."',
  ]) {
    assert.equal(verdict(command), 'allow', `launcher over-refused: ${command}`);
  }
});

// ---------------------------------------------------------------------------
// Encoded and rebuilt script text
// ---------------------------------------------------------------------------

test('every PowerShell abbreviation of -EncodedCommand is decoded', () => {
  const body = Buffer.from('Clear-RecycleBin -Force', 'utf16le').toString('base64');
  for (const flag of ['-EncodedCommand', '-EncodedComman', '-Encoded', '-enc', '-en', '-e']) {
    assert.equal(verdict(`pwsh ${flag} ${body}`), 'deny/empty-recycle', `${flag} was not decoded`);
  }
});

test('a script block built from a literal is judged by its body', () => {
  for (const command of [
    '& ([scriptblock]::Create("Remove-Item C:\\x\\a.txt"))',
    '. ([scriptblock]::Create("Remove-Item C:\\x\\a.txt"))',
    `${DOLLAR}sb=[scriptblock]::Create("Remove-Item C:\\x\\a.txt"); & ${DOLLAR}sb`,
    '[scriptblock]::Create("Clear-RecycleBin -Force")',
  ]) {
    assert.notEqual(verdict(command), 'allow', `script block body not read: ${command}`);
  }
});

test('a script block or Invoke-Expression over unreadable text is refused', () => {
  for (const command of [
    `[scriptblock]::Create(${DOLLAR}code)`,
    `${DOLLAR}sb = [scriptblock]::Create(${DOLLAR}text); & ${DOLLAR}sb`,
    `Invoke-Expression ${DOLLAR}var`,
    'iex (Get-Content build.ps1)',
  ]) {
    assert.equal(verdict(command), 'deny/opaque', `unreadable body allowed: ${command}`);
  }
});

test('a harmless script block, and an iex over a literal that deletes nothing, pass', () => {
  for (const command of [
    '[scriptblock]::Create("Write-Output \'hi\'")',
    'Invoke-Expression "Write-Output \'hi\'"',
    `${DOLLAR}x = [scriptblock]`,
  ]) {
    assert.equal(verdict(command), 'allow', `harmless construct refused: ${command}`);
  }
});

test('a file whose name contains "iex" is not an Invoke-Expression call', () => {
  // Caught on the real corpus: `\b` matches `iex` inside `t6-whatif-iex.mjs`, so three
  // commands that only moved or redirected that file were refused.
  for (const command of [
    'Move-Item temp\\t6-whatif-iex.mjs temp\\renamed.mjs',
    'node temp\\t6-whatif-iex.mjs',
    'Get-Content t6-whatif-iex.mjs',
  ]) {
    assert.equal(verdict(command), 'allow', `file name mistaken for a call: ${command}`);
  }
});

test('a script block literal containing parentheses is read, not called unreadable', () => {
  // The body is ordinary script text: `(1+1)` is a parenthesis, not the end of the
  // call. Matching the first `)` truncated it, so the literal looked like an
  // expression built at run time and was refused for the wrong reason.
  for (const command of [
    '[scriptblock]::Create("Write-Output (1+1)")',
    `[scriptblock]::Create("if (Test-Path C:\\x) { 'ok' }")`,
    '& ([scriptblock]::Create("Write-Output (2*3)"))',
    "[scriptblock]::Create('Get-ChildItem | Measure-Object')",
  ]) {
    assert.equal(verdict(command), 'allow', `readable literal refused: ${command}`);
  }
});

test('a launcher argument that merely names a wipe program is not an erase', () => {
  for (const command of [
    'Start-Process -FilePath notepad -ArgumentList "sdelete.exe"',
    'Start-Process -FilePath cmd -ArgumentList "/c","dir C:\\tools\\shred"',
    // These were refused in 2.4.3 too, for the same reason: the wipe name was found
    // anywhere in the argv instead of in the position the launcher runs it from.
    'cmd /c echo sdelete',
    'cmd /c findstr shred notes.txt',
    'cmd /c dir C:\\tools\\shred',
  ]) {
    assert.equal(verdict(command), 'allow', `data mistaken for a program: ${command}`);
  }
});

test('the wipe program in its actual position is still found', () => {
  // The mirror of the case above: widening the position must not lose the real one.
  for (const command of [
    'cmd /c sdelete C:\\secret.txt',
    'cmd /d /x /c sdelete C:\\secret.txt',
    'cmd /c "sdelete -p 3 C:\\secret.txt"',
    'Start-Process -FilePath shred -ArgumentList "-u /tmp/x"',
    'Start-Process -WindowStyle Hidden -PassThru -FilePath shred -ArgumentList "-u /tmp/x"',
    'Start-Process -FilePath cmd.exe -ArgumentList "/c","sdelete C:\\secret"',
    'Start-Process sdelete -ArgumentList "-p 3 C:\\secret"',
  ]) {
    assert.equal(verdict(command), 'deny/wipe', `wipe program missed: ${command}`);
  }
});

test('switch order does not change whether the payload is found', () => {
  // PowerShell cmdlets take their switches in any order, so the check must not depend on
  // it. An earlier version stopped scanning at `-ArgumentList`, so every spelling with it
  // written first was allowed — six shapes, measured 2026-11-25.
  for (const command of [
    'Start-Process -FilePath shred -ArgumentList "-u /tmp/x"',
    'Start-Process -ArgumentList "-u /tmp/x" -FilePath shred',
    'Start-Process -ArgumentList "-p 3 C:\\secret" -FilePath sdelete',
    'Start-Process -WindowStyle Hidden -FilePath shred -ArgumentList "-u /tmp/x"',
    'Start-Process -WindowStyle Hidden -ArgumentList "-u /tmp/x" -FilePath shred',
    'Start-Process -ArgumentList "/c","sdelete C:\\secret" -FilePath cmd.exe',
    'Start-Process -ArgumentList "-d C:\\x" -FilePath format-volume',
  ]) {
    assert.equal(verdict(command), 'deny/wipe', `payload lost when the switch order changed: ${command}`);
  }
});

test('a valued switch of the launcher does not become the program slot', () => {
  // `-WindowStyle Hidden shred` puts `Hidden` right where the program is read from; the
  // launcher's own valued switches have to be stepped over.
  assert.equal(verdict('Start-Process -WindowStyle Hidden shred'), 'deny/wipe');
  assert.equal(verdict('Start-Process -WorkingDirectory C:\\tmp sdelete -ArgumentList "-p 3"'), 'deny/wipe');
  // …and the mirror: a file name that merely ends in a wipe name is not a program.
  assert.equal(verdict('Start-Process -WindowStyle Hidden shred.txt'), 'allow');
  assert.equal(verdict('Start-Process -WorkingDirectory C:\\tmp notepad'), 'allow');
});

test('switch order alone does not make a harmless call refused', () => {
  for (const command of [
    'Start-Process -ArgumentList "-u /tmp/x" -FilePath notepad',
    'Start-Process -ArgumentList "-u /tmp/x" -FilePath cmd.exe',
    'Start-Process -Verb Open -ArgumentList "notes.txt" -FilePath notepad',
  ]) {
    assert.equal(verdict(command), 'allow', `harmless call refused: ${command}`);
  }
});

test('a command too deeply nested to read is refused, not cleared', () => {
  // `cmd /c` chains really run — verified by putting `echo` where the wipe program would
  // be — so a chain the parser cannot follow must fail closed. Measured 2026-11-25: five
  // levels of `cmd /c` around `sdelete` used to be allowed, because the depth guard
  // answered "not a wipe" for a statement it had simply stopped reading.
  const nest = (n, tail) => `${'cmd /c '.repeat(n)}${tail}`;

  // Readable: the program is named.
  for (const n of [1, 2, 3, 4]) {
    assert.equal(verdict(nest(n, 'sdelete C:\\x')), 'deny/wipe', `${n}-deep chain should name the program`);
  }
  // Unreadable: refused, with a reason that says so rather than pretending it is clean.
  for (const n of [5, 6, 8]) {
    assert.equal(verdict(nest(n, 'sdelete C:\\x')), 'deny/opaque', `${n}-deep chain must not be cleared`);
  }
  // The same limit applies to a harmless tail — that is what fail-closed costs.
  assert.equal(verdict(nest(5, 'echo hi')), 'deny/opaque');
  // …while ordinary nesting of ordinary commands is untouched.
  for (const n of [1, 2, 3, 4]) {
    assert.equal(verdict(nest(n, 'echo hi')), 'allow', `${n}-deep harmless chain should pass`);
  }
});

test('nesting different shells is read through, not counted as one level each time', () => {
  for (const command of [
    'cmd /c powershell -c cmd /c sdelete C:\\x',
    'powershell -NoProfile -c "cmd /c sdelete C:\\x"',
    'cmd /c powershell -c "pwsh -c sdelete C:\\x"',
  ]) {
    assert.equal(verdict(command), 'deny/wipe', `mixed nesting not read: ${command}`);
  }
  for (const command of [
    'cmd /c cmd /c echo hi',
    'cmd /c powershell -NoProfile Get-Date',
    'powershell -c "cmd /c echo hi"',
  ]) {
    assert.equal(verdict(command), 'allow', `harmless mixed nesting refused: ${command}`);
  }
});

test('a program that hands its string to a shell is a delete one layer down', () => {
  // `execSync('Remove-Item x')` and `os.system(<delete>)` run a shell command from inside a
  // child process. Nothing else here looked at them: the deleting APIs are known by name
  // (`rmSync`, `rmtree`), and the spawn call was consulted only when the payload named a
  // wipe program — so both spellings were allowed while the direct one was refused.
  // Measured 2026-11-25.
  const Q = "'";
  for (const command of [
    `node -e "require(${Q}child_process${Q}).execSync(${Q}Remove-Item x${Q})"`,
    `node -e "require(${Q}child_process${Q}).execSync(${Q}rm -rf /tmp/x${Q})"`,
    `node -e "const {execSync} = require(${Q}child_process${Q}); execSync(${Q}del x${Q})"`,
    `python -c "import os; os.system(${Q}Remove-Item x${Q})"`,
  ]) {
    assert.equal(verdict(command), 'deny/script', `shell delete from inside a program: ${command}`);
  }
});

test('a body that only prints the verb is not a delete', () => {
  // The mirror. Refusing these made it impossible to write a fixture, a note or a test
  // about the guard without leaving the tool call — and the verb in there erases nothing.
  const Q = "'";
  for (const command of [
    `node -e "console.log(${Q}Remove-Item x${Q})"`,
    `python -c "print(${Q}Remove-Item x${Q})"`,
    `bash -c "echo Remove-Item x"`,
    `pwsh -c "Write-Output ${Q}Remove-Item x${Q}"`,
  ]) {
    assert.equal(verdict(command), 'allow', `printing the verb refused: ${command}`);
  }
  // …but a body with a real delete after the print still refuses: the body is split first.
  assert.equal(verdict(`bash -c "echo starting; rm -rf /tmp/x"`), 'deny/script');
  assert.equal(verdict(`pwsh -c "Write-Output hi; Remove-Item C:\\x"`), 'deny/script');
});

test('an assigned here-string is data, not a program', () => {
  // A here-string holds text. `$b = @'…'@` stores it; nothing inside runs. The text scans
  // that look for `[scriptblock]::Create(…)` and inline-shell bodies match raw characters,
  // so a note that *quotes* such a call was read as making the call — measured 2026-11-25,
  // on a release note listing `& ([scriptblock]::Create("Remove-Item …"))` as an example.
  const HERE = (body) => `@'\n${body}\n'@`;
  for (const command of [
    `$b = ${HERE(`- & ([scriptblock]::Create("Remove-Item x")) is refused`)}\nWrite-Output $b`,
    `$b = ${HERE('the rule refuses Remove-Item')}\nWrite-Output $b`,
    `$b = ${HERE('pwsh -enc <base64> decodes to a command')}\nWrite-Output $b`,
    `$b = ${HERE('cmd /c powershell -c sdelete x is refused')}\nWrite-Output $b`,
  ]) {
    assert.equal(verdict(command), 'allow', `documentation read as code: ${command.split('\n')[1]}`);
  }
});

test('a here-string that IS the program is still read', () => {
  // The mirror, and the reason the mask only covers the assigned form: here the here-string
  // is the body handed to an interpreter, so its text really does run.
  const HERE = (body) => `@'\n${body}\n'@`;
  for (const [command, kind] of [
    [`python -c ${HERE('import shutil; shutil.rmtree("x")')}`, 'deny/script'],
    [`node -e ${HERE('require("fs").rmSync("x")')}`, 'deny/script'],
    [`bash -c ${HERE('shred -u /tmp/x')}`, 'deny/wipe'],
    [`& ([scriptblock]::Create(${HERE('Remove-Item x.txt')}))`, 'deny/opaque'],
  ]) {
    assert.equal(verdict(command), kind, `a here-string body was hidden: ${command.split('\n')[1]}`);
  }
});

test('a bare iex takes its text from the pipe, which cannot be read', () => {
  // `@'…'@ | iex` was allowed: the scan for an unreadable body saw nothing after `iex` and
  // read that as "nothing to read", while `iex $b` with the same content was refused.
  const HERE = (body) => `@'\n${body}\n'@`;
  for (const command of [
    `${HERE('Remove-Item x.txt')} | iex`,
    `${HERE('Remove-Item x.txt')} | Invoke-Expression`,
    `Get-Content script.txt | iex`,
  ]) {
    assert.equal(verdict(command), 'deny/opaque', `piped input allowed: ${command.split('\n')[0]}`);
  }
  // A literal body still passes, so ordinary one-liners are untouched.
  assert.equal(verdict('Invoke-Expression "Write-Output \'hi\'"'), 'allow');
});

test('a shell command line is read through, not stopped at its head', () => {
  // A shell runs the program named in its arguments, and a shell can be started by another
  // launcher. Reading only the head of the statement missed four shapes, all measured
  // 2026-11-25 — each was allowed while the same program written directly was refused.
  for (const command of [
    // cmd -> powershell -> the program
    'cmd /c powershell -c sdelete C:\\x',
    // powershell with the program as its first positional argument
    'powershell -NoProfile shred -u /tmp/x',
    // the same, through Start-Process
    'Start-Process -FilePath powershell -ArgumentList "-NoProfile shred -u /tmp/x"',
    // cmd compound statement: the program sits behind `if`
    'cmd /c if exist C:\\x sdelete C:\\secret',
    'cmd /c if not exist C:\\x sdelete C:\\secret',
    'cmd /c for %f in (*.log) do sdelete %f',
    // a payload that is itself several statements
    'bash -c "cd /tmp && shred -u x"',
    'powershell -NoProfile -c "cd C:\\tmp; sdelete C:\\x"',
  ]) {
    assert.equal(verdict(command), 'deny/wipe', `payload not read through: ${command}`);
  }
});

test('reading a shell through does not turn its data into programs', () => {
  // The mirror, and the reason this is judged by position rather than by name: every line
  // here mentions a wipe program without running one.
  for (const command of [
    'powershell -NoProfile Get-ChildItem',
    'powershell -NoProfile -Command "Get-Date"',
    'powershell -NoProfile -Command "Get-Command shred"',
    'powershell -NoProfile -Command "Select-String shred notes.txt"',
    'pwsh -NonInteractive -File build.ps1',
    'powershell -ExecutionPolicy Bypass -File deploy.ps1',
    'bash -c "npm run build"',
    'bash -lc "ls -la"',
    'cmd /c echo sdelete',
    'cmd /c where sdelete',
    'cmd /c if exist C:\\x echo sdelete',
    'cmd /c for %f in (*.log) do echo %f',
    'Start-Process -FilePath powershell -ArgumentList "-NoProfile Get-Date"',
    'Start-Process -FilePath pwsh -ArgumentList "-Command","git status"',
  ]) {
    assert.equal(verdict(command), 'allow', `data read as a program: ${command}`);
  }
});

// ---------------------------------------------------------------------------
// Volume-level erase
// ---------------------------------------------------------------------------

test('PowerShell Storage cmdlets that erase a volume or disk are refused', () => {
  for (const command of [
    'Format-Volume -DriveLetter D -FileSystem NTFS -Confirm:$false -Force',
    'Clear-Disk -Number 1 -RemoveData -Confirm:$false',
    'Initialize-Disk -Number 1 -PartitionStyle MBR',
  ]) {
    assert.equal(verdict(command), 'deny/wipe', `disk cmdlet allowed: ${command}`);
  }
});

test('reading disk state is not erasing it', () => {
  for (const command of [
    'Get-Volume',
    'Get-Disk',
    'Get-Volume -DriveLetter D | Format-Table',
  ]) {
    assert.equal(verdict(command), 'allow', `read-only disk query refused: ${command}`);
  }
});

// ---------------------------------------------------------------------------
// Refusal reasons name the thing that was actually written
// ---------------------------------------------------------------------------

test('each untranslatable target form gets its own reason', () => {
  assert.match(reason(`Remove-Item ${DOLLAR}var`), /variable `\$name`/);
  assert.match(reason(`Remove-Item ${DOLLAR}{TARGET_DIR}`), /braced variable/);
  assert.match(reason(`Remove-Item ${DOLLAR}(Get-ChildItem .)`), /command substitution/);
  // A backtick before a *special* character produces a control character or breaks the
  // quoting, so the name cannot be written down and the refusal must name the escape. A
  // backtick before an ordinary character just escapes it, so that target is a literal and
  // is redirected — see `guard.test.mjs`.
  assert.match(reason('Remove-Item "backup`n.txt"'), /backtick escape/i);
  assert.doesNotMatch(reason('Remove-Item "backup`n.txt"'), /command substitution/i);
  assert.equal(verdict('Remove-Item `Get-Date`'), 'rewrite/delete');
});

// ---------------------------------------------------------------------------
// Driving the Recycle Bin's own verbs
// ---------------------------------------------------------------------------

const BIN_ITEMS = `(New-Object -ComObject Shell.Application).NameSpace(0xA).Items() | % { ${DOLLAR}_.`;

test('a destroy verb the name lists do not mention is still refused', () => {
  // `Purge` and `Empty` are not in the delete-word list, and the ordinary way to reach
  // an item's verbs spans a pipe — so the bin reference sat in a different statement
  // and these verbs were allowed. Measured 2026-11-25.
  for (const verb of ['Purge', 'Empty', 'Delete', 'Remove', '删除']) {
    assert.equal(verdict(`${BIN_ITEMS}InvokeVerb('${verb}') }`), 'deny/empty-recycle', `verb not seen: ${verb}`);
  }
});

test('a verb with no argument runs the default verb, which is not in the text', () => {
  assert.equal(verdict(`${BIN_ITEMS}InvokeVerb() }`), 'deny/empty-recycle');
  assert.equal(verdict(`${BIN_ITEMS}DoIt() }`), 'deny/empty-recycle');
});

test('restoring and looking are still allowed', () => {
  // Refusing a restore is the failure mode on the other side of this rule: the model
  // asked to put something back and was told it was emptying the bin.
  for (const verb of ['Restore', 'Undelete', '还原']) {
    assert.equal(verdict(`${BIN_ITEMS}InvokeVerb('${verb}') }`), 'allow', `restore refused: ${verb}`);
  }
  assert.equal(verdict(`${BIN_ITEMS}Verbs() | % { ${DOLLAR}_.Name } }`), 'allow', 'listing verbs is not driving');
  assert.equal(verdict(`Get-ChildItem 'C:\\${DOLLAR}Recycle.Bin' -Force`), 'allow', 'reading the bin is allowed');
});

test('driving a verb on something that is not the bin stays allowed', () => {
  const notBin = `(New-Object -ComObject Shell.Application).NameSpace(17).Items() | % { ${DOLLAR}_.InvokeVerb('Open') }`;
  assert.equal(verdict(notBin), 'allow');
});

test('naming the bin by path in one statement does not convict another', () => {
  // `$Recycle.Bin` is also ordinary text. Letting it travel across statements made a
  // search for that string refuse an unrelated `InvokeVerb` — measured 2026-11-25.
  for (const command of [
    `Select-String -Path notes.md -Pattern '${DOLLAR}Recycle.Bin'; ${DOLLAR}x.InvokeVerb('copy')`,
    `Get-Content 'C:\\${DOLLAR}Recycle.Bin\\readme.txt'; ${DOLLAR}i.InvokeVerb('copy')`,
    `${DOLLAR}r='C:\\${DOLLAR}Recycle.Bin'; Get-ChildItem ${DOLLAR}r; ${DOLLAR}o=New-Object -ComObject Shell.Application; ${DOLLAR}o.NameSpace(17).Items() | % { ${DOLLAR}_.InvokeVerb('Open') }`,
  ]) {
    assert.equal(verdict(command), 'allow', `path text convicted another statement: ${command}`);
  }
});

test('reaching the bin as an object still travels down the pipe', () => {
  // The reason the reference is allowed to cross statements at all: `NameSpace(0xA)`
  // yields the items, and the verb that drives them is in the next statement.
  for (const namespace of ['0xA', '10']) {
    assert.equal(
      verdict(`(New-Object -ComObject Shell.Application).NameSpace(${namespace}).Items() | % { ${DOLLAR}_.InvokeVerb('Purge') }`),
      'deny/empty-recycle',
      `object reference did not travel: ${namespace}`,
    );
  }
});
