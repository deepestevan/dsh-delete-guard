# dsh-delete-guard

**English** | [简体中文](README.md) | [日本語](README.ja.md)

Refuses the delete commands a model issues and moves the target into the Windows
Recycle Bin instead.

```
agent:   Remove-Item -Recurse -Force .\src
refused: The delete guard blocked this delete. Re-run this as: file_trash with paths = ["…\src"]
then:    file_trash → moved to the Recycle Bin, "Restore" works
```

```
agent:   $lines=Get-Content $f; $idx=(…Select-String…).LineNumber; Set-Content $f $lines[0..($idx-2)]
refused: …`$idx` is offset by arithmetic in a slice endpoint, it is never checked for $null…
         Fix, then re-run:  if (-not $idx) { throw "anchor not found" }
```

## The problem

In DSH a model's `pwsh` delete erases files outright: `ctx.fs` has no delete,
`ctx.shell` has only `execute()`, and nothing sits in between. One
`Remove-Item -Recurse -Force` takes a directory with it — no bin, no undo.

This plugin hooks `tools/pre-execute` (the seam the host actually routes every
tool call through), **refuses** those calls, and tells the model to use
`file_trash`. That tool moves items with `SHFileOperationW(FOF_ALLOWUNDO)` — the
same Win32 call Explorer uses — so the `$I`/`$R` metadata in `$Recycle.Bin` is
correct and Restore works.

Coverage goes past `Remove-Item`: pipelines, `xargs`, variable-built targets,
`if { }` blocks, inline `-Command` / `-EncodedCommand`, the persistent terminal,
Git Bash `/c/...` paths, and every spelling of emptying the bin.

There is a second class with **no delete verb at all**: read a file, compute a
slice, write it back over the same file. In PowerShell `$lines[0..($null-2)]` is not
an error — it is `$lines[0..-2]`, the first line plus the last two, so a 605-line
file can be saved as 24 lines silently. Such a command cannot go to the bin (a
network share has none) and cannot be caught by comparing sizes afterwards, so the
guard refuses it before the write: read-then-rewrite of one file, and an unchecked
slice endpoint that feeds a write.

## Install

```shell
# from npm
dsh plugin --profile web add dsh-delete-guard
# or straight from the repository
dsh plugin --profile web add github:deepestevan/dsh-delete-guard
# or from a local tarball (when you have changed the source)
pnpm pack --pack-destination ./temp/pack     # bump `version` first
dsh plugin --profile web add file:./temp/pack/dsh-delete-guard-2.4.2.tgz
# restart dsh web: lib/*.js is loaded at process start
```

Update with `remove` then `add`: a lone `add` can answer `Already up to date` and change
nothing, and `lib/*.js` is only reloaded when the process restarts.

## What it blocks

**Redirected into the Recycle Bin**

```
Remove-Item C:\tmp\a.txt        del / erase / rd / rmdir / rm / unlink
Remove-Item -Recurse -Force C:\tmp\dir
if (Test-Path $p) { Remove-Item $p -Force }
terminal_send: "Remove-Item C:\tmp\a.txt"
```

**Refused outright**

| Category | Examples |
| --- | --- |
| Targets that cannot be proven | `Remove-Item $(…)`, `… \| Remove-Item`, `xargs rm`, `Remove-Item @targets`, `-Recurse C:\tmp\*` |
| Dangerous paths | `C:\`, `\`, `C:\Windows`, `Program Files`, `..\..\`, Git Bash `~` and `/tmp` |
| Erases with no delete verb | `[System.IO.File]::Delete(…)`, `Invoke-Expression "…"`, `cmd /c del`, `robocopy /MIR`, `find -delete` |
| Permanent-erase tools | `shred`, `sdelete`, `srm`, `cipher /w`, `format X:` (matched in program position only) |
| Emptying the bin | `Clear-RecycleBin` (bare, `&`, child shell, `-EncodedCommand`), `SHEmptyRecycleBin`, driving bin items' shell verbs, deleting `$Recycle.Bin` contents |
| Locations without a bin | UNC shares and exFAT/FAT32 volumes, where "recycling" is a permanent erase |
| Deletes inside scripts | shell / Python / Node inline bodies, and writing delete text into `.ps1`/`.sh`/`.py` |
| **Reading a file and rewriting it in one command** | `(Get-Content $f) \| Set-Content $f`, `$c = Get-Content $f; Set-Content $f $c`, `sed -i f`, `cat f > f`, `::ReadAllText` → `::WriteAllText` — the new content comes from the only copy, so a wrong slice or filter leaves nothing to restore. The `.bak` / verified-temp spelling is allowed |
| **A read folded into the write statement** | `Set-Content $f (Get-Content $f \| Select-Object -First 10)` — reads, truncates and writes back on one line |
| **A shell invoked through a variable** | `$shellPath='…bash.exe'; & $shellPath -c "rm -rf …"` — the program is not a literal, so the body cannot be judged |
| **An unchecked slice endpoint** | a command that both writes a file and slices with `$idx ± n` (`$l[0..($idx-2)]`, `-First ($i-1)`) where `$idx` was never checked for `$null`. PowerShell does not error: `0..($null-2)` *is* `0..-2` — the first line plus the last two |

**Allowed**: read-only work, commands that only mention a delete word
(`Select-String -Pattern "Remove-Item"`, `Get-Content shred.exe`), **restoring**
files out of the bin, `Add-Content` / `>>` / `-Append` (an append replaces
nothing), writes to `$null` / `/dev/null`, a full rewrite that first copies the file
to `.bak` or writes a temp file it verifies, and a wipe-program **name mentioned** inside a
`node -e` / `python -c` body — it is a program only when it reaches `exec` / `execSync` / `spawn` / `system` /
`subprocess.*` (a `bash -c` body is shell text and is judged whole).

## Two tools

| Tool | Purpose |
| --- | --- |
| `file_trash { paths, reason? }` | The only permitted way to delete. Local items move into the Recycle Bin; share items are copied to a local volume, verified, recycled there, and only then removed (see "Network shares"). Reports per-path results |
| `trash_status { drive? }` | Item count and byte size of the bin on a volume, to confirm a deletion landed |

## Configuration

Override in the profile's `cordis.patch.yml` (`config` is replaced as a whole
block — restate every key you want to keep):

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `blockDestructiveCommands` | `true` | Intercept shell deletes and redirect to `file_trash` |
| `forbidEmptyRecycleBin` | `true` | Refuse emptying or modifying the bin |
| `forbidWipe` | `true` | Refuse `shred` / `sdelete` / `srm` / `cipher /w` / `format` |
| `blockScriptDeletes` | `true` | Refuse deletes in script files and inline strings |
| `blockTruncatingWrites` | `true` | Refuse read-then-rewrite of the same file, and an unchecked slice endpoint in a command that writes |
| `uncRecoverableMove` | `true` | Share deletes: copy to a local NTFS volume, verify, recycle the copy, then remove the original. `false` keeps the plain refusal |
| `stagingRoot` | `%LOCALAPPDATA%\dsh-delete-guard\staging` | Staging directory for share deletes (must be on a local volume with a bin) |

## Restoring a deleted file

Restoring is handled by the OS Recycle Bin.
Explorer's right-click "Restore" works. From a script, read the
`X:\$Recycle.Bin\<SID>\$I*` records (offset 24 = original path length in chars,
offset 28 = UTF-16LE path), match the one you want, and `Move-Item` its paired `$R`
file back. The `$R`/`$I` names are random, so those records are the only index;
skip any whose payload is missing. Do not depend on the localized verb name.

## Network shares (no Recycle Bin)

A UNC path has no Recycle Bin: `SHFileOperationW` erases there and reports success,
which is why the bridge refuses those paths. `file_trash` now does what a person does
by hand, in one call, in a fixed order:

1. copy the item to a local NTFS volume that does have a bin
   (`%LOCALAPPDATA%\dsh-delete-guard\staging\<timestamp>-<name>`, override with `stagingRoot`);
2. verify the copy against the original: same relative paths, same kinds, same sizes;
3. recycle the staging folder — the copy is now restorable;
4. only then remove the original.

**What that guarantees**: the *content* is recoverable from the local bin; the
*original path* is not, because the share has no bin to hold it — step 4 is an
ordinary permanent delete. The order is therefore the safety property: any failure
before step 4 leaves the original untouched, and step 4 runs only after the bridge
confirms the staged copy is in the bin.

A restore lands in the staging path, not back on the share (the bin's `$I` record
holds the staging location), so the tool prints that path in its result.

Refused, all before any copy: a share root (`\\host\share`) or a bare host; a tree
containing a **reparse point** (junction/symlink — a copy either duplicates the
target's contents or needs privileges to recreate the link); **not enough free
space** on the staging volume.

`uncRecoverableMove: false` refuses a share path outright: nothing is copied and nothing is deleted.

## What it does not cover

| Not covered | Why |
| --- | --- |
| Deletes already inside a script file | The guard never sees the body; it refuses the write and the inline forms it can see |
| Arbitrary C# through `Add-Type` (e.g. `DeleteFileW`) | Out of reach for text matching; only the bin-specific API is named and blocked |
| A command name assembled into a variable, then `& $c` | Cannot be evaluated textually |
| Execution channels outside the tool list (custom-named shells, third-party plugins) | The list is explicit — see below |
| A delete split across two terminal sends | Each send is judged on its own text |
| Non-Windows platforms | The bridge is `SHFileOperationW` |
| Free-space exhaustion | A same-volume NTFS recycle is a rename and consumes no space, so there is nothing to pre-check |
| **Overwriting without reading** (`echo x > notes.md`, `Invoke-WebRequest -OutFile`, `git checkout -- f`) | The new content does not depend on the old, so this is not read-modify-write |
| **Indirect writes inside a read-modify-write** (compilers, `npm run build`, `robocopy` over build output) | The write happens in a child process; the command text names no provable target |
| Judging a truncation by size afterwards | Rolling back needs the old bytes, and `tools/post-execute` can only turn a result into feedback |
| Moving something off a share (`Move-Item`, `robocopy /MOV`) | The content reaches the destination, but the share copy is unlinked for good and no bin record exists |

Covered shell tools: `pwsh`, `powershell`, `cmd`, `bash`, `sh`, `zsh`, `shell`,
`terminal_send`, `terminal_write`.

## Tests

```shell
node test/run-all.mjs
```

148 cases across eight layers: command classification (50), overwrite guard (30),
rule holes (12), share staging (8), `file_trash` operand guard (15), host schema +
hook wiring (14), host schema acceptance (5), live end-to-end against the real
Recycle Bin (14, including a real `\\localhost\C$` path). `test/` is not shipped in the tarball, so it
must be green before packing; two layers load the host's own validators and report
**skipped** (not failed) where no DSH install exists. The overwrite-guard layer pins both
directions in one file: the dangerous shapes are refused, and ordinary work (builds, git,
log and config rewrites) still passes.

## Documentation

| File | Contents |
| --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | Version summaries |
| [SECURITY.md](SECURITY.md) | Threat model: a policy layer, not a sandbox |
| [docs/incidents/](docs/incidents/) | Measured evidence behind each rule, with the verbatim command (not in the npm package) |
| [LICENSE](LICENSE) | MIT |



## License

MIT — see [LICENSE](LICENSE).
