# Security notes

## What this plugin is

A **policy layer** on top of the model's tool calls. It intercepts the command
text a model is about to run and either refuses it or redirects it to a tool that
moves the target into the OS Recycle Bin.

It is **not** a sandbox. It does not confine what a process may do to the file
system, and it is not meant to stop a deliberate attacker who already controls the
command line.

## What it does protect

- An agent deleting files the user still needs — the ordinary failure mode. Every
  recognised delete is refused and redirected to `file_trash`
  (`SHFileOperationW(FOF_ALLOWUNDO)`), so the item is recoverable from Explorer.
- Locations where "delete" would actually mean "erase": UNC shares and
  exFAT/FAT32 volumes are refused before the shell is called, because
  `SHFileOperationW` erases there and still reports success.
- Irreversible side doors: permanent-erase programs, erases performed through
  .NET APIs, `Invoke-Expression`, deletes delegated to `cmd.exe`, and every
  spelling of emptying the Recycle Bin.

## Out of scope (by design, and verified as limits)

The full list, with evidence, is in [README.md](README.md) 「不挡什么」; the per-rule measurements live in the maintainer's engineering notes (not shipped). The ones that matter for
a security read:

- `Add-Type` compiles arbitrary C#; nothing textual can stop it from calling
  `DeleteFileW`. The guard names the bin-specific API (`SHEmptyRecycleBin`) and
  leaves the general case to the operating system's permissions.
- Commands assembled at run time (`& $cmd`, `$c='Clear-Recycle'+'Bin'; & $c`) are
  invisible to a text-level parser.
- A delete split across two `terminal_send` calls cannot be assembled from either
  half.
- Tools outside the covered list (`pwsh`, `powershell`, `cmd`, `bash`, `sh`,
  `zsh`, `shell`, `terminal_send`, `terminal_write`) are not inspected at all.
- Deletes inside a script file whose body the guard never sees: it refuses the
  write and the inline forms it can see, not the executed body.

## Reporting

Once this repository is public, use a GitHub Security Advisory (or a private
message to the maintainer) rather than a public issue for anything that lets a
recognised delete bypass the Recycle Bin.

Please include: the exact command text, which tool carried it, the DSH version,
and whether the target was on NTFS, a UNC path, or another file system. Do not
paste real paths from a private machine — reduce them to the smallest form that
still reproduces the behaviour.
