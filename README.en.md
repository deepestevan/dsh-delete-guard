# dsh-delete-guard

**English** | [简体中文](README.md) | [日本語](README.ja.md)

**An agent cannot delete what it cannot recover.**

A deletion has exactly two outcomes here: it lands in the Windows Recycle Bin
(restorable from Explorer), or it is refused and re-issued as a `file_trash`
call. There is no third one.

```
agent:   Remove-Item -Recurse -Force .\src
refused: The delete guard blocked this delete. Re-run this as: file_trash with paths = ["…\src"]
then:    file_trash → moved to the Recycle Bin, "Restore" works
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

## Install

```shell
# from npm
dsh plugin --profile web add dsh-delete-guard
# or straight from the repository
dsh plugin --profile web add github:deepestevan/dsh-delete-guard
# or from a local tarball (when you have changed the source)
pnpm pack --pack-destination ./temp/pack     # bump `version` first
dsh plugin --profile web add file:./temp/pack/dsh-delete-guard-2.2.2.tgz
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

**Allowed**: read-only work, commands that only mention a delete word
(`Select-String -Pattern "Remove-Item"`, `Get-Content shred.exe`), and
**restoring** files out of the bin.

## Two tools

| Tool | Purpose |
| --- | --- |
| `file_trash { paths, reason? }` | The only permitted way to delete. Moves to the Recycle Bin, reports per-path results, never falls back to a permanent erase |
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

## Restoring a deleted file

Restoring is not a plugin feature and needs none: the bin belongs to the OS.
Explorer's right-click "Restore" works. From a script, read the
`X:\$Recycle.Bin\<SID>\$I*` records (offset 24 = original path length in chars,
offset 28 = UTF-16LE path), match the one you want, and `Move-Item` its paired `$R`
file back. The `$R`/`$I` names are random, so those records are the only index;
skip any whose payload is missing. Do not depend on the localized verb name.

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

Covered shell tools: `pwsh`, `powershell`, `cmd`, `bash`, `sh`, `zsh`, `shell`,
`terminal_send`, `terminal_write`. Reasoning and measurements:
the decision is made on the statement's command word, the shape of the call, and program position — never on a word appearing somewhere in the line.

## Tests

```shell
node test/run-all.mjs
```

90 cases across five layers: command classification (49), `file_trash` operand
guard (15), host schema + hook wiring (11), host schema acceptance (5), live
end-to-end against the real Recycle Bin (10). `test/` is not shipped in the
tarball, so it must be green before packing; two layers load the host's own
validators and report **skipped** (not failed) where no DSH install exists.

## Documentation

| File | Contents |
| --- | --- |
| [CHANGELOG.md](CHANGELOG.md) | Version summaries |
| [SECURITY.md](SECURITY.md) | Threat model: a policy layer, not a sandbox |
| [LICENSE](LICENSE) | MIT |

Design rationale, the per-round measurements and the release runbook are engineering
notes kept by the maintainer; they are not part of this repository or package.

## License

MIT — see [LICENSE](LICENSE).
