# Changelog

All notable changes to this plugin. Dates are the day the tarball was packed on
this machine (`temp/pack/dsh-delete-guard-<ver>.tgz`), which is the artifact
each profile actually ran.

The long-form reasoning behind every entry — what was measured, what was
rejected, what the trade-off costs — lives in the maintainer's engineering notes (`INCIDENTS.md`, not shipped since 2.2.0).

## [2.4.3] — 2026-11-26

**A failed delete now says what actually failed.** Reported from use: a directory whose
files could all be deleted would not delete itself, and the model worked around it by
renaming things until something took. Reproduced both causes, and both produced a
message that pointed at the wrong thing.

### `0x2` said "the path no longer exists" while the path was there

A name ending in a space or a dot can exist on NTFS — WSL, an archive extractor, a sync
client or a port of a POSIX tool creates them — but Win32 trims those trailing
characters when a name is written into a path. `SHFileOperationW` walks the tree, the
child's own open fails with `ERROR_FILE_NOT_FOUND`, and the whole call returns `0x2`.
Measured 2026-11-25: a directory with one such child refuses; the same directory with
the child's name normalised recycles.

The old message was a lie about the path. It now names the offending entries and says
why, listing through the `\\?\` prefix — the one spelling in which Win32 takes the name
literally — capped at eight so a pathological tree cannot flood the reply.

### `0x20` said "access is denied" with no hint of why

A directory held as some process's working directory, or holding an open file, returns
`DE_ACCESSDENIED`. Every file inside can still be deleted; the directory cannot, until
the process lets go. That is exactly the reported symptom.

The message now says a process is probably using it, that the contents can still go
individually, and that this tool **will not guess** which process — enumerating handles
needs elevation, and a screenshot of a guessed PID list would be worse than no answer.
Note what is *not* claimed: a share-mode probe of the directory does not detect a cwd
holder (measured — it opens cleanly), so there is no cheap reliable detector, which is
why this is a message rather than a verdict.

### The `\\?\` prefix was refused as a network share

`Test-RecyclableVolume` matched `\\*`, so `\\?\C:\…` — a local path — was answered with
"a network location has no Recycle Bin". `isNetworkPath` in `staging.js` had the same
bug and sent such paths down the staging branch, where they were copied and recycled
from a staging directory instead of in place.

The bridge now strips the prefix before judging (`\\?\UNC\host\share\x` becomes the
ordinary UNC spelling, so the share rules see what they expect), and `isNetworkPath`
judges the two prefixes separately.

**Why strip rather than pass through:** `SHFileOperationW` does not accept the prefix at
all. Measured: the same file returns `0x7C` (DE_INVALIDFILES) with the prefix and
recycles without it, and a 316-character path recycles fine unprefixed — so stripping
loses no capability and removes a false "network location" verdict.

### Not done, on purpose

The tool does not rename the offending entries, delete inside a directory it was asked
to delete, or kill the process holding it. Each would make this test pass and be the
wrong behaviour: they change the user's files or processes to satisfy a delete that the
user asked for by name. The message is the deliverable.

### Tests

148 → **155** across ten layers. New layer ⑨ `test/diagnosis.test.mjs` (7 cases) pins
both diagnoses, the prefix handling for local and UNC spellings, and that an absent path
gets no diagnosis. Every case asserts the operator side too: the malformed child is still
there afterwards, the held directory still has its contents, nothing was "fixed".

## [2.4.2] — 2026-11-25

**Renumbering false positives from real measurements.** The rules from 2.3.0 / 2.4.0 were
built from one incident each. This release is built from **62,131 shell commands that
actually ran on this machine** (5,746 session logs), re-classified with today's matcher:
1,580 would now be refused, and **432 of those were false positives (0.70% of all
commands)**. Three independent audits — two per-command, one code-level — plus my own
mechanical re-checks. Evidence: `docs/incidents/2026-11-24-rule-false-positive-sweep.md`,
plan: `docs/incidents/2026-11-24-fix-plan-2-4-2.md`.

### `in-place-rewrite`: two conditions instead of a new rule

The rule stays "reads the same file it writes". What was missing was **order** and
**recoverability** — not a different predicate.

- **Order.** A read that happens only *after* the last write is a verification read-back;
  its value cannot feed a write that already ran. Releases 330 historical commands.
  - `.NET` writes participate: giving them no statement index made the last-write lookup
    return `-1`, which emptied the read set and would have let **223** `.NET`
    read→write commands through — including the shape §9.4 of the incident record
    claims is covered.
  - Suppressed inside any repetition construct (`for`, `foreach`, `while`, `do`, `until`,
    `switch`, `%`/`ForEach-Object`, `.ForEach(`), because there textual order is not
    execution order. The first gate listed only three keywords and missed `%`, the
    commonest spelling.
- **Recoverability.** A copy step now has to be an actual statement writing a *different*
  path derived from the target, **before** the overwrite. The previous check was a
  whole-text `BACKUP_MARKER.test(command)`, so all three of these were exempted while
  truly rewriting a file from its only copy: a `.bak` in a trailing comment, a `.bak` in
  the target's own name, and a `.bak` in an unrelated string.
  - `sed -i.bak` still counts — the editor makes the copy itself, in the same statement.
  - A temp file holding the **new** content is **not** a backup: verifying the output does
    not make the input recoverable. Refused (this was 4 historical commands).

### A bounded substitution with the codec pinned is the `edit` tool

`$t = $t.Replace('a','b')` written back is a targeted change, not a rebuild. It is now
allowed when **both** sides state an encoding, which is the condition that actually
matters: `Get-Content -Raw` on a GBK document decodes it wrong, and `WriteAllText` then
writes the mojibake back — measured, with an ASCII needle the occurrence check passes and
every CJK character becomes `U+FFFD`. Encoding continuity is what prevents it; a
replacement-count check does not.

Not allowed: a document-wide regex (`-replace '(?s)^.*$'` reduces a file to one
character), a substitution applied to a slice, and a substitution with no codec stated.
Releases 183 commands (44% of the cluster).

### Four holes the sweep found (not false positives — the opposite)

| Command | Was | Now |
| --- | --- | --- |
| `Remove-Item x.txt -WhatIf` | `rewrite/delete` → told the model to re-run it as `file_trash` | rendered as a dry run: "this previewed, nothing was deleted" |
| `$i.InvokeVerb('delete')` alone | **allowed** (the rule needed a bin reference in the same command) | refused |
| `$i.Verbs() \| % { $_.DoIt() }` | **allowed** | refused |
| `const {execSync}=require('child_process'); execSync('…')` | **allowed** (every spawn branch required a leading dot) | refused |

The first is a safety inversion, not friction: the user asked to preview and the guard
advised destroying the file. The fix renders dry runs differently rather than dropping
them from classification — dropping statements let the word `-WhatIf` in a comment or a
string exempt a real write (measured, three cases).

Also: `-WhatIf`/`-Confirm`/`-Verbose`/`-Debug` are switches, not value-taking flags.
Listing them as value-taking made `Remove-Item -Verbose C:\x\a.txt` report "no explicit
operands", so the model was told its delete had no target instead of being handed the
paths.

### Smaller corrections

- `.Verbs()` is enumeration, not driving: the sanctioned restore path and read-only bin
  listings are allowed again.
- `DoIt()` is never exempted by a restore word — a comment saying `# restore` laundered it.
- `Remove-Item variable:x` / `env:X` / `function:x` / `alias:X` are allowed: they delete
  no file, and the old behaviour handed the model `file_trash "variable:x"`, an
  instruction that cannot work. `HKCU:`/`Cert:`/`WSMan:` are refused **without** a
  file_trash hint — the bin cannot hold a registry key.
- `Invoke-Expression` is judged by its body, not by the word.
- A shell invoked through a variable (`$shellPath='…bash.exe'; & $shellPath -c "…"`) is
  refused when the body deletes. Previously the `$sh='bash'` spelling was caught only
  because the variable *name* contains `sh`.
- `Select-String <pattern> <file>`: `-Path`'s value was eaten by `skip: 1`, so
  `Select-String -Path a.md -Pattern x | Set-Content a.md` was allowed.
- A read folded into the write statement (`Set-Content $f (Get-Content $f | Select-Object -First 10)`)
  is now a read. Four variants were allowed; this is the incident in one line.

### Costs, stated

- **Latency: +11% best-case, +16% median** on 6,000 real commands (41 interleaved rounds,
  25 blocks, both versions in one process; the two-version comparison is in
  `temp/bench-decisive.mjs`). The classifier was ~165 µs/command and is now ~192 µs.
  For scale: one `stat()` is ~5 µs, one PowerShell spawn (what `file_trash` does) is
  ~70 ms — the guard is 0.3% of a trash call. A cheap precondition in the hook
  (two regexes, verified to skip **no** command the classifier would block, on all 6,000)
  keeps the new checks off the 88% of commands that neither read nor write.
- **Not reached:** the plan's target was "误伤 < 130". The measured result is **432 → 241**.
  The remainder is dominated by 156 commands whose *read* side states no encoding — refused
  on purpose, since that is the mojibake hazard — plus 24 with no encoding on either side
  and the `UNSURE` group whose writes come from an external script.
- **`real` count drops 1,148 → 852, which looks like over-relaxation and is not.** Verified
  mechanically: across the 5,917 commands now allowed, **zero** are "same file, read before
  write". The drop is the sweep's own classifier mislabeling write-then-read-back
  (`python x.py | Out-File out.txt; Get-Content out.txt`) as a whole-file rewrite. The
  acceptance criteria were changed to a shape gate for this reason.

### Tests

116 → **148**, eight layers. New layer ③ `test/holes.test.mjs` (12 cases) pins each hole
and each correction with the direction it must move; layer ② grew from 22 to 30 cases
covering order, `.NET` ordering, folded reads, repetition, real-vs-fake backup steps,
pinned encoding, and the four "no discard token" rebuilds that keep the rule from
degenerating into a token list.

## [2.4.1] — 2026-11-24

The publish workflow's first run, and what it found. No production code changed.

Releasing 2.4.0 ran `test/run-all.mjs` on Ubuntu for the first time in this
repository's history — no tags, no releases, no prior workflow runs; 2.2.3 reached
npm through a hand-run `npm publish`. Layer ④ came back **4 pass / 11 fail**:
`move-guard.test.mjs` asserts Windows path semantics (`C:\` is a drive root,
`..\..` resolves inside a volume, `\\host\share` is a UNC share, `C:\Program Files`
is refused), and on a POSIX runner `node:path` is posix, so `C:\` is an ordinary
relative name and `resolve()` prepends the checkout path.

Fix: layers ③ ④ ⑦ are gated on `process.platform === 'win32'` in
`test/run-all.mjs` and report **skipped** elsewhere, with the measurement recorded
in the comment. The plugin is `os: ["win32"]` and the bridge is
`SHFileOperationW`: a POSIX runner cannot exercise those paths at all, so gating is
the honest answer rather than a workaround.

This also corrects a claim in 2.3.0 — "layers ① ② ④ ⑥ pass anywhere" was derived
from forcing `process.platform='linux'` on Windows, which leaves `node:path` bound
to win32 at load time, so the check proved nothing about the other platform. CI was
the only evidence, and it had never run. Same failure mode as the rules this
release series added: a check that looks green because it never exercised the thing
it names.

## [2.4.0] — 2026-11-15

**Deleting from a network share now works instead of being refused.** A share has
no Recycle Bin: `SHFileOperationW(FOF_ALLOWUNDO)` erases there and returns 0
(reproduced 2026-10-23), so 2.3.0 refused every UNC path — safe, but the deletion
never happened and the model had to invent a workaround.

`file_trash` now does what a person does by hand, in one call, in this order:

1. copy the item to a staging directory on a volume that does have a bin
   (`%LOCALAPPDATA%\dsh-delete-guard\staging\<yyyyMMdd-HHmmss>-<name>`, override
   with `stagingRoot`);
2. verify the copy against the original — same relative paths, same kinds, same
   file sizes;
3. recycle the staging folder — the copy is now in the bin and restorable;
4. only then remove the original.

**What this guarantees, stated exactly**: the *content* is recoverable from the
local Recycle Bin; the *original path* is not, because the share has no bin to hold
it. Step 4 is an ordinary permanent delete. That is why the order is the safety
property — every failure before step 4 leaves the original untouched, and step 4
runs only after the bridge confirms the staged copy left for the bin. A failure in
step 4 is reported with the paths that remain, never as success.

Restoring lands in the staging path, not back on the share: the bin's `$I` record
holds the staging location, so `file_trash` prints it in its result and the render
says so. That is the one place where "delete a share file" is not the same as
"delete a local file", and it is visible rather than implied.

**Refused, with the reason** (each one stops before any copy):
- a share root (`\\host\share`) or a bare host — those are not items, and staging
  them would copy and then delete everything on the share;
- a tree containing a **reparse point** (junction/symlink): a copy either
  duplicates the target's contents or needs privileges to recreate the link, so it
  is not a faithful copy;
- **insufficient free space** on the staging volume, checked from the measured size
  before copying, so a 50 GB tree fails in a second instead of halfway.

**Verified vs not**: entry sets, kinds and sizes are compared; content hashes are
not (both sides of a 50 GB tree). The result reports `verification` so nobody reads
more into "verified" than it means.

New config: `uncRecoverableMove` (default `true`; `false` restores the plain 2.3.0
refusal and deletes nothing), `stagingRoot`. New required output field `staged[]`
(`path`, `staged`, `recycled`, `sourceRemoved`, optional `verification` and
`remaining`) — a share deletion is *not* reported in `recycled`, because the
original path never goes to a bin.

Also found while reading the resolution path: `file_trash` with `\\host` (no share)
used to resolve to `<cwd drive>:\host` — a *local* file that has nothing to do with
the share the caller meant — and would happily recycle it. The shape is now refused.

Cost, stated: a share delete copies the whole item, so it is O(size) in time and
needs that much free space on the staging volume; a very large tree may exceed the
tool call's timeout. Windows' own cross-volume `Move-Item` has the same cost, but no
verification and no bin record.

Tests: 116 → 128. New layer ③ `test/staging.test.mjs` (8 cases: step order, a
truncated copy that never reaches the bin, a failed recycle that keeps the
original, a junction that stops the delete, share-root/host refusal) plus three
`file_trash`-level cases in `e2e.test.mjs`, one of which deletes a real
`\\localhost\C$\…` path end to end (reported **skipped** where the admin share is
unreachable, rather than passing vacuously).

**A documentation incident, recorded because it is the same failure mode as 2.3.0's.**
Applying these README changes with a scripted `String.replace(needle, text)` put one
replacement string containing `` $` `` (the `\\localhost\C$` code span, closed by a
backtick). JavaScript reads `` $` `` in a string replacement as "everything before
the match" and expanded it, so each README ended up containing itself twice — 6.5 KB
became 13 KB, silently, and it survived a heading-level spot check because both
copies were plausible. Caught by counting H1s (2 instead of 1) and by noticing a
`README.md` whose first copy had no 文档/许可 sections. Rebuilt from `HEAD` with a
function-based replacer (never `String.replace(_, string)` when the replacement
contains `$`), every anchor asserted to match exactly once, and the result checked
structurally: 11 sections and 44 table rows in each of the three files. The lesson is
2.3.0's lesson one layer up: a rule that silently matches more than intended looks
exactly like a rule that worked.

## [2.3.0] — 2026-11-15

Content destroyed **without a delete verb** is now covered. Found by measurement,
not by review: a 605-line ledger was rewritten to 24 lines by

```powershell
$lines=Get-Content $f
$idx=($lines | Select-String -Pattern '^# 备用｜同步电机' | Select-Object -First 1).LineNumber
$keep=$lines[0..($idx-2)]
Set-Content -LiteralPath $f -Value ($keep + $new) -Encoding UTF8
```

There is no delete verb in that command, so every 2.2.3 rule was correctly silent.
`$idx` was `$null` (the anchor matched nothing) and PowerShell reads
`$lines[0..($null-2)]` as `$lines[0..-2]` — `$lines[0,-1,-2]`, the first line plus
the last two. Measured on pwsh 7 with a 10-element array: `L1,L10,L9`. No error,
no warning. Record and verbatim evidence:
`docs/incidents/2026-11-14-full-file-rewrite-truncation.md`.

New module `lib/rewrite-guard.js` (pure, no I/O), wired into `classifyCommand`
after the erase/script rules and **before** the redirect collection — `file_trash`
is the remedy for a delete, and it is the wrong remedy here (see below). New
config key `blockTruncatingWrites` (default `true`).

**Rule 1 — `in-place-rewrite`.** The same file is read *and* written by one
command (`Get-Content f … | Set-Content f`, `$c = Get-Content f; Set-Content f $c`,
`sed -i f`, `cat f > f`, `[IO.File]::ReadAllText` → `::WriteAllText`). Reused or
rewritten: the operand-key comparison resolves `$f` against a `$f='literal'`
assignment in the same command, so a literal on one side and a variable on the
other still match. Allowed when the command itself keeps a copy (`.bak`/`.orig`
destination, or a temp file it copies over the original) — which is exactly the
safe pattern the incident record's §6 recommends, so that spelling passes
untouched.

**Rule 2 — `slice-risk`.** A range/slice endpoint of the form `<var> ± n` whose
variable is never asserted, in a command that also writes a file. Endpoints proven
non-null (`.Count`, `Measure-Object`, a literal) and asserted variables
(`if (-not $idx)`, `$idx -eq $null`, …) do not fire. A read-only command with the
same bad slice stays allowed: it prints the wrong lines and destroys nothing, and
refusing it would cost a round trip and protect nothing.

**Rejected: "overwrite an existing file = delete it" (proposed as R1).** Three
reasons, in order of weight. (a) The remedy does not exist where the failure
happened: the target was on a UNC share, and `scripts/recycle-bin.ps1` refuses
those because `SHFileOperationW` erases there and reports success — "recycle the
old copy, then write" is a no-op on the case that motivated it. (b) The rule is a
verb list one vocabulary later, i.e. the same structural blind spot: `Export-Csv`,
`[IO.File]::WriteAllText`, `Invoke-WebRequest -OutFile`, `tee`, `dd of=`, `cp`,
`truncate`, `sed -i`, a compiler over its own output — any enumeration is
incomplete and reads as complete. (c) Its consequence, "every overwrite is a
delete", is the opposite of this plugin's own policy: `write` and `edit` overwrite
files, and the prompt says to prefer them.

**Rejected: post-write size fuse, refuse-and-roll-back (R2).** Roll-back requires
the old bytes, so the copy has to be taken *before* the write — which needs the
target set (the same enumeration problem) — and `tools/post-execute` cannot undo
anything: `PostToolDecision.block` only turns the result into feedback for the
next request, after the truncation already happened. Snapshotting a tree per shell
call is O(workspace) and would still have missed this incident's file, which sat
on a UNC share outside every workspace root.

**Not `ask`.** In an auto-approving deployment (this machine: approval policy
`never`) `ask` resolves to allow in the same tick — a rule that looks present and
does nothing. Deny-with-a-recipe is honest whether or not a human is watching.

**Also fixed, found while doing the above.** Maintaining this repository was
refused by the published 2.2.3: the rule that looks for a wipe-program name inside
an inline body matched the name **anywhere** in the body, so a `node -e` script
whose *prose* quoted `shred` was denied as if it were about to erase the disk
(measured 2026-11-15 — the guard blocked the `node -e` edit of this very README).
A shell body (`bash -c "…"`) is shell text, so the name anywhere in it may run; a
JavaScript or Python body is not, and the name only becomes a command when it
reaches `exec`/`execSync`/`spawn`/`system`/`subprocess.*`. Split at
`wipeProgramInInlineBody`: shell interpreters keep the whole-name rule, other
interpreters require a process-spawning call after the name. Spawned wipes are
still refused (`execSync('shred -u x')`, `os.system('sdelete …')`).

Costs, stated: the in-place rule is deliberately over-inclusive for "read a file,
then regenerate it from something else in the same command" (the fix is one
`Copy-Item` line, and the message says so); `Add-Content`, `>>`, `-Append`,
`2> $null`, `> /dev/null` and `Clear-Content`-only commands are untouched; `>` onto
an existing file *without* reading it is still allowed and is listed in the
README's 「不挡什么」.

Tests: 90 → 116. New layer ② `test/rewrite.test.mjs` (22 cases: the incident
verbatim, the assertion fix, the §6 safe pattern, every in-place spelling, the
null-device/appendix exceptions, dialect spellings, the precedence case) plus three
hook-level cases in `registration.test.mjs` proving `apply()` actually wires the
rules and that `blockTruncatingWrites: false` disables them, plus the inline-body
scoping cases in `guard.test.mjs`. The "ordinary work stays allowed" corpus (42
commands: build, git, publish, log and config plumbing) lives in the same file as
the incident regression on purpose — a rule that catches the incident and also
refuses `npm run build` is not a fix.

`lib/shell-text.js` extracted: the lexer (`splitStatements`, `tokenize`,
`unquote`, `commandWord`) is now shared by both rule modules instead of imported
across them, which would have been a cycle. `guard.js` re-exports the same four
names, so nothing downstream changes.

## [2.2.3] — 2026-10-23

npm publish prerequisites; no behaviour change.

- READMEs (`zh`/`en`/`ja`): the first install line is now the registry spec
  `dsh plugin --profile web add dsh-delete-guard`, with `github:deepestevan/dsh-delete-guard`
  and the local tarball kept as the alternatives.
- `.github/workflows/publish.yml`: release-time publish over GitHub OIDC (trusted
  publishing, `id-token: write`), no `NPM_TOKEN` secret. It upgrades npm first —
  Node 22 ships npm 10, and trusted publishing needs ≥ 11.5.1.
- `test/run-all.mjs`: the e2e layer is gated on `win32`, so the same command is
  green on the Linux CI runner (one suite skipped, reported as such). Verified by
  forcing `process.platform='linux'`.
- `package.json`: `publishConfig.access` explicit; the root-package-only
  `repository.directory` removed.

## [2.2.2] — 2026-10-23

- All three READMEs now open the install section with the repository spec
  (`dsh plugin --profile web add github:deepestevan/dsh-delete-guard`) and keep the
  local tarball flow as the "you changed the source" alternative. A public repo
  whose first command is a `pnpm pack` path is written for its author, not its user.

## [2.2.1] — 2026-10-23

Registry metadata for the first publish; no behaviour change.

- `package.json`: `repository` / `homepage` / `bugs` / `author` filled with
  `github.com/deepestevan/dsh-delete-guard`.
- `LICENSE`: copyright holder is the account name, not "contributors" — this is a
  single-author project, and the handle is already the repo owner on every commit.

## [2.2.0] — 2026-10-23

Publishing policy; no behaviour change. The repository now ships only what a user
or an integrator needs; the engineering notes moved out of it.

- `docs/` removed from the repository and from the package (`files`). The three
  documents (design rationale, per-round incident log, release runbook) moved to
  the maintainer's notes tree. They described how this plugin was built, not how to
  use it — and one of them quoted a private hostname and UNC path from the
  measurement that proved the 1.0.5 hole.
- What used to be a link now sits in the READMEs as one sentence: "the decision is
  made on the statement's command word, the shape of the call, and program
  position — never on a word appearing somewhere in the line." The threat model
  stays in `SECURITY.md`.
- Reference for the split: the upstream project keeps architecture documents in its
  repository `docs/` but publishes packages with a runtime-only `files` whitelist
  (`packages/shell/tool-pwsh/package.json` → `locale/*.json`, `lib/index.js`,
  `lib/types/**/*.d.ts`). Nothing in the published artifact is a build record.

## [2.1.2] — 2026-10-23

- `docs/RELEASING.md` quoted this machine's absolute paths and user name
  (`C:\Users\<user>\…`, the author's workspace layout). Generalised to
  `%DSH_HOME%` / `<repo>\temp\pack`. A release runbook that leaks its author's
  directory layout is not publishable.

## [2.1.1] — 2026-10-23

- Three READMEs pointed at `docs/DESIGN.md` for both "judging criteria" and the
  measurements. The measurements are in `INCIDENTS.md`; the pointer was split.

## [2.1.0] — 2026-10-23

Docs restructure; no behaviour change. The README had become a lab notebook —
361 lines of per-version forensics, defensive caveats and provenance maths — which
is the wrong document for a repository's front page.

- `README.md` rewritten as a release document: what it is in one line, the problem
  it removes, install in three commands, a before/after of a blocked delete, what
  gets redirected vs refused, the two tools, configuration, how to restore, then
  the limits as one compact table. 361 → ~170 lines.
- The evidence moved verbatim (nothing retyped) into two documents:
  `DESIGN.md` (why this shape: judging criteria, rejected alternatives, costs,
  implementation notes) and `INCIDENTS.md` (per-round incidents, measurements,
  and the lesson about verification method). These two, plus the release runbook,
  were moved out of the repository in 2.2.0.
- `README.en.md` and `README.ja.md` rebuilt to the same shape and length.
- Stale cross-references (`README.md` 「已知限制」, `README.md` 「1.0.x 修的是
  什么」) repointed to `SECURITY.md` and this
  changelog.

## [2.0.2] — 2026-10-23

`trash_status` reported `Recycle Bin on F:: 59 item(s)` — the caller's drive
string already carries its colon and the render appended a second one. Found by
the live probe right after the 2.0.0 restart, i.e. by using the tool the way a
model does.

(2.0.1 carried the same code fix; it was superseded within the hour because its
changelog entry was written after packing, which breaks the "installed == packed"
invariant this file exists to protect.)

## [2.0.0] — 2026-10-23

**Renamed: `dsh-recycle-bin-guard` → `dsh-delete-guard`** (cordis id
`recycle-bin-guard` → `delete-guard`, error `RecycleBinGuardError` →
`DeleteGuardError`, prompt section `delete-guard`). No behaviour change; the
package had never been published, so no alias is needed.

Why: the old name puts "guard" on the wrong noun. What is guarded is *deletion* —
the plugin refuses every unrecoverable delete and routes it into the bin. It does
not protect the bin; it protects the user from the bin being bypassed, and it also
refuses emptying the bin. Named for the bin, a reader can conclude the opposite of
what it does.

Measured on a local snapshot of the ecosystem index (4,377 plugins, from awesome-dsh-plugin.com):

- 3,740 names (85 %) start with `dsh-`; median name length 15, p90 22. `dsh-delete-guard` is 16.
- 62 names are `…-guard` with the **target** in the middle (`dsh-egress-guard`,
  `dsh-write-rule-guard`, `dsh-tool-call-guard`, `dsh-disk-guard`). The target of
  this one is deletion, so the convention points at `delete-guard`.
- `trash` and `recycle` appear in 0 of 4,377 names, so the old name had no search
  overlap in the ecosystem; `dsh-safe-delete` (the closest neighbour) owns the
  "safe delete" phrase.
- The platform stays out of the name (only ~10 of 4,377 put `win`/`windows` in it);
  it belongs in the description and the `windows` topic, which both carry it.

## [1.0.11] — 2026-10-23

Docs; no behaviour change.

- Three READMEs with a language switcher line at the top of each:
  `README.md` (简体中文, the measurement log — GitHub's default display),
  `README.en.md`, `README.ja.md`. The English and Japanese files contain no
  Chinese prose; the switcher is the only CJK in the English one.
- Release runbook (`RELEASING.md`, maintainer-side): how to create the repository and set topics, with the
  measured topic table (which topics this ecosystem actually uses, and the counts
  they were measured at), plus the `gh repo create` / `gh repo edit` commands.
- `package.json` `keywords` aligned with the topic list.

## [1.0.10] — 2026-10-23

Docs and test portability; no behaviour change.

- `test/dsh-install.mjs`: the two layers that import the host's schema validators
  no longer hard-code this machine's DSH install path. They locate it
  automatically and **report as skipped** (not failed) when there is none, with
  `DSH_NODE_MODULES` as an override. A public repository cannot ship a test
  command that only runs on the author's box.
- `README.en.md` / the release runbook: say how that lookup works and that a
  `pass 0` run means the host layers were skipped.

## [1.0.9] — 2026-10-23

Publishing metadata only; no behaviour change.

- Add `LICENSE` (MIT), `SECURITY.md`, `CHANGELOG.md`, `README.en.md`,
  the release runbook.
- `package.json`: drop the `types` field — it pointed at `lib/index.d.ts`, which
  has never existed, so TypeScript consumers resolved nothing. Declare
  `"os": ["win32"]` (the Recycle Bin bridge is Win32-only). Ship the new
  documents in the package (`files`).

## [1.0.8] — 2026-10-23

Coverage for shells other than `pwsh`.

- **Persistent terminal is now inspected.** `terminal_send` types into a live
  PTY and never passes through the `pwsh`/`bash` tools, so a delete there ran
  unguarded (measured: `Remove-Item …` executed with the guard on the same call
  path). The hook now reads a tool table (`SHELL_TOOLS`) instead of two hard-coded
  names.
- **Git Bash paths are translated.** `rm -rf /c/tmp/x` used to be redirected with
  the literal POSIX path, which Node resolves to `<cwd drive>:\c\tmp\x` — a
  different location. `/x/…` and `/cygdrive/x/…` now become `X:\…`; `~`, `/tmp`,
  `/usr` and other MSYS mount points are refused rather than guessed.

## [1.0.7] — 2026-10-23

Emptying the Recycle Bin, in every spelling.

- 1.0.6 blocked only the literal `Clear-RecycleBin` at the start of a statement.
  Also blocked now: `& "Clear-RecycleBin"`, `pwsh -Command "…"` and
  `Start-Process … -ArgumentList "…"`, `-EncodedCommand` bodies (decoded before
  judging), `SHEmptyRecycleBin`, and driving the bin items' own shell verbs
  (`InvokeVerb('delete')`, `Verbs()` + `DoIt()`).
- Measured, not assumed: PowerShell rejects abbreviated cmdlet names (`Clear-R`,
  `Get-Loc` → `CommandNotFoundException`), and the OS confirmation dialog only
  covers the shell-verb path — `Clear-RecycleBin -Force`, `SHEmptyRecycleBin` and
  deleting `$Recycle.Bin` contents directly are silent.

## [1.0.6] — 2026-10-23

- Remove the dead capacity gate (`checkCapacity`, the bridge's `capacity` op, and
  the `minFreeBytes` / `reserveBytes` config keys). On NTFS the bin shares the
  item's volume, so a recycle is a rename that consumes no space; a free-space
  gate could only refuse harmless deletes. The real question — does this volume
  have a bin at all — is answered since 1.0.5.

## [1.0.5] — 2026-10-23

- **Refuse locations that have no Recycle Bin** (UNC shares, exFAT/FAT32
  volumes). `SHFileOperationW` with `FOF_ALLOWUNDO` does not fail there: it erases
  the item, returns 0, and the "did the path leave?" check cannot tell that from
  a recycle. Reproduced on a UNC share: file gone, no `$I`/`$R` record on any
  local volume, `SHQueryRecycleBin` unchanged, tool reporting "Moved to the
  Recycle Bin". The bridge now decides before the call
  (`Test-RecyclableVolume`).

## [1.0.4] — 2026-10-23

Structure instead of substrings.

- `.NET` erases are matched as **calls** (`::Delete(`, `.Delete(`, `.Delete()`),
  not as the type literal `[System.IO.File]` — that pattern refused every
  read-only System.IO call, e.g. reading a `.bat` file to count its bytes.
- Permanent-erase program names are matched in **program position** (command
  word, launcher argument, or an inline shell body), so `Get-Content shred.exe`
  and `grep -n "shred" *.md` are no longer refused.
- `Clear-RecycleBin` is matched in command position only, so searching for the
  string in this README is allowed.
- Closed the reverse hole: the no-argument instance form
  (`(Get-Item $p).Delete()`) was never caught.

## [1.0.3] — 2026-10-18

- Evidence may not cross statements. `python -c "…del d['a']…" ; bash -c "echo ok"`
  was refused because `bash` in one statement convicted the `del` in another. The
  shell-inline and script-write rules are judged per statement; the two rules that
  must stay whole-command (non-shell inline bodies, script-file writes) say why in
  the code.

## [1.0.2] — 2026-10-18

- **Block-wrapped deletes are seen.** `{` `}` joined the statement separators
  (a real `Remove-Item` had run unguarded inside an `if (…) { … }`), and the
  operand parser steps over wrapper prefixes (`(`, `&`, `.`, `$x =`).
- **Erases without a delete verb are denied** (`ERASE_CONSTRUCTS`).
- Flag values are no longer mistaken for targets
  (`-ErrorAction SilentlyContinue`), splats are refused, and the whole-text
  substring rules that refused read-only work were replaced by shape-specific
  checks.

## [1.0.1] — 2026-09-28

- Add the landing-side operand guard (`lib/move-guard.js`): the shell rules only
  policed commands, so a direct `file_trash` call could target a drive root, the
  Windows directory, or the session workspace root.
- Fix two stale tests that compiled the hand-written JSON Schema with the
  `defineTool` DSL helpers and always reported `UNSUPPORTED_SCHEMA`.

## [1.0.0] — 2026-09-25

- First working version: `tools/pre-execute` hook, the `file_trash` /
  `trash_status` tools, the `SHFileOperationW(FOF_ALLOWUNDO)` bridge, and the
  command-side rule table.
