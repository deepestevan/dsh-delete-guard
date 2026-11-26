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
dsh plugin --profile web add github:deepestevan/dsh-delete-guard#v2.4.5
# or from a local tarball (when you have changed the source)
pnpm pack --pack-destination ./temp/pack     # bump `version` first
dsh plugin --profile web add file:./temp/pack/dsh-delete-guard-2.4.5.tgz
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
| **Wildcard targets** | `Remove-Item C:\tmp\*.log`, `del dist\*`: `file_trash` does not expand wildcards — list the entries, then pass explicit paths |
| Dangerous paths | `C:\`, `\`, `C:\Windows`, `Program Files`, `..\..\`, Git Bash `~` and `/tmp` |
| Erases with no delete verb | `[System.IO.File]::Delete(…)`, `Invoke-Expression "…"`, `cmd /c del`, `robocopy /MIR`, `find -delete` |
| **Git working-tree operations** | `git clean -fd`, `git rm`, `git reset --hard`, `git checkout -- <path>`, `git restore <path>`: none of them names a delete verb, and the content is gone anyway |
| Permanent-erase tools | `shred`, `sdelete`, `srm`, `cipher /w`, `format X:`, `diskpart clean` (matched in program position only) |
| **A command name spelled with backticks** | ``s`delete``, ``Clear-Recy`cleBin``, ``R`emove-I`tem``: in PowerShell a backtick is an escape, so the real name is judged |
| Emptying the bin | `Clear-RecycleBin` (bare, `&`, child shell, `-EncodedCommand`), `SHEmptyRecycleBin`, driving bin items' shell verbs, deleting `$Recycle.Bin` contents |
| Locations without a bin | UNC shares, mapped network drives (`S:` → a share), exFAT/FAT32 volumes, where "recycling" is a permanent erase |
| Deletes inside scripts | shell / Python / Node inline bodies, and writing delete text into `.ps1`/`.sh`/`.py` |
| **Reading a file and rewriting it in one command** | `(Get-Content $f) \| Set-Content $f`, `$c = Get-Content $f; Set-Content $f $c`, `cat f > f`, `::ReadAllText` → `::WriteAllText` — the new content comes from the only copy. `sed -i` passes only for a bounded `s///` script; `d` and whole-line patterns stay refused. The spelling that copies the **target** to `<name>.bak` / `.tmp` / `.new` first is allowed |
| **Leaving a file empty** | `Clear-Content $f`, `Set-Content $f ''`, `truncate -s 0 $f`, a bare `> $f`, `cp /dev/null $f` — the old content is not saved anywhere; a one-step write that carries new content is unaffected |
| **A read folded into the write statement** | `Set-Content $f (Get-Content $f \| Select-Object -First 10)` — reads, truncates and writes back on one line |
| **A shell invoked through a variable** | `$shellPath='…bash.exe'; & $shellPath -c "rm -rf …"` — the program is not a literal, so the body cannot be judged |
| **An unchecked slice endpoint** | a command that both writes a file and slices with `$idx ± n` (`$l[0..($idx-2)]`, `-First ($i-1)`) where `$idx` was never checked for `$null`. PowerShell does not error: `0..($null-2)` *is* `0..-2` — the first line plus the last two |

**Allowed**: read-only work, commands that only mention a delete word
(`Select-String -Pattern "Remove-Item"`, `Get-Content shred.exe`), **restoring**
files out of the bin, `Add-Content` / `>>` / `-Append` (an append replaces
nothing), writes to `$null` / `/dev/null`, a full rewrite that first copies the
**target** to `<name>.bak` / `.tmp` / `.new`, and a wipe-program **name mentioned** inside a
`node -e` / `python -c` body — it is a program only when it reaches `exec` / `execSync` / `spawn` / `system` /
`subprocess.*` (a `bash -c` body is shell text and is judged whole).

## Two tools

| Tool | Purpose |
| --- | --- |
| `file_trash { paths, reason? }` | The only permitted way to delete. Local items move into the Recycle Bin; share items are copied to a local volume, verified, recycled there, and only then removed (see "Network shares"). Reports per-path results |
| `trash_status { drive? }` | Item count and byte size of the bin on a volume, to confirm a deletion landed. A failed read is reported as an error, not as "0 items" |

## Configuration

Override in the profile's `cordis.patch.yml` (`config` is replaced as a whole
block: an omitted key takes its default, and every default is `true`, so a key you set
to `false` has to be restated to stay off):

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `blockDestructiveCommands` | `true` | Intercept shell deletes and redirect to `file_trash` |
| `forbidEmptyRecycleBin` | `true` | Refuse emptying or modifying the bin |
| `forbidWipe` | `true` | Refuse `shred` / `sdelete` / `srm` / `cipher /w` / `format` |
| `blockScriptDeletes` | `true` | Refuse deletes in script files and inline strings |
| `blockTruncatingWrites` | `true` | Refuse read-then-rewrite of the same file, and an unchecked slice endpoint in a command that writes |
| `blockEmptyWrites` | `true` | Refuse commands that leave a file with no content (`Clear-Content`, an empty `Set-Content`, `truncate -s 0`, a bare redirect) |
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

A mapped network drive (`S:` → `\\host\share`) has no bin either: the letter form is
not UNC, but the bridge judges the drive type, refuses it outright, and does not stage
it as a share. To keep the content, copy the item to a local NTFS volume first.

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
| **Overwriting without reading** (`echo x > notes.md`, `Invoke-WebRequest -OutFile`) | The new content does not depend on the old, so this is not read-modify-write. Leaving the file **empty** is different: that is refused |
| **Indirect writes inside a read-modify-write** (compilers, `npm run build`, `robocopy` over build output) | The write happens in a child process; the command text names no provable target |
| Judging a truncation by size afterwards | Rolling back needs the old bytes, and `tools/post-execute` can only turn a result into feedback |
| Moving something off a share (`Move-Item`, `robocopy /MOV`) | The content reaches the destination, but the share copy is unlinked for good and no bin record exists |
| **A directory holding a name Windows cannot open** (trailing space or dot, usually left by WSL, an extractor or a sync client) | Win32 trims the trailing character when the name goes into a path, so the tree cannot be walked. The tool names the entry and the reason; renaming it so the name no longer ends with a space or dot makes the directory deletable |
| **A directory a process is using** (its working directory, or an open file inside) | It can be deleted once that process exits. The tool says that is what happened, which is what you need to go and find the process; it does not look for it for you |

Covered shell tools: `pwsh`, `powershell`, `cmd`, `bash`, `sh`, `zsh`, `shell`,
`terminal_send`, `terminal_write`.

## Tests

```shell
node test/run-all.mjs
```

233 cases across fourteen layers: command classification (50), overwrite guard (43),
rule holes (12), share staging (8), `file_trash` operand guard (20), host schema +
hook wiring (14), host schema acceptance (5), live end-to-end against the real
Recycle Bin (15, including a real `\\localhost\C$` path), failure diagnosis (7),
cross-shell judgement (14), pre-filter consistency (5), escape shapes (32), argument shapes (8).
`test/` is not shipped in the tarball, so it
must be green before packing; two layers load the host's own validators and report
**skipped** (not failed) where no DSH install exists. The overwrite-guard layer pins both
directions in one file: the dangerous shapes are refused, and ordinary work (builds, git,
log and config rewrites) still passes. One further layer checks the documentation
(`scripts/verify-readme-structure.mjs`): the three READMEs must have the same sections and
the same number of table rows.

## Documentation

| File | Contents |
| --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each version |
| [SECURITY.md](SECURITY.md) | Threat model: a policy layer, not a sandbox |
| [docs/archive/incidents/](docs/archive/incidents/) | Measured evidence behind each rule, with the verbatim commands — in the GitHub repository |
| [LICENSE](LICENSE) | MIT |



## License

MIT — see [LICENSE](LICENSE).
