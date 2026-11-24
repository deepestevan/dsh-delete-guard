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
- Volumes whose file system has no bin at all (exFAT/FAT32): refused before the
  shell is called, because `SHFileOperationW` erases there and still reports
  success.
- **Deletion on a share, which has no bin.** `file_trash` copies the item to a
  local NTFS volume, verifies the copy (entry set, kinds, sizes), recycles the
  staging folder, and only then removes the original. The guarantee is about
  **content**, not about the original path: after a successful delete the bytes are
  in the local bin and the item at the share path is gone, because there is no bin
  on that volume to hold it. The step order is the safety property — any failure
  before the last step leaves the original untouched, and the last step runs only
  after the bridge confirms the staged copy is in the bin. A share root, a tree
  containing a reparse point, and a staging volume without room are all refused
  before any copy.
- Irreversible side doors: permanent-erase programs, erases performed through
  .NET APIs, `Invoke-Expression`, deletes delegated to `cmd.exe`, and every
  spelling of emptying the Recycle Bin.
- **Content destroyed without a delete verb**: a command that reads a file and
  overwrites that same file (`Get-Content f … | Set-Content f`, `sed -i f`,
  `cat f > f`), and a command that slices with an unchecked `$null`-able endpoint
  and then writes the result. Both are refused, and the refusal names the
  copy-then-verify recipe that makes the write undoable. This is the one class
  where routing to the bin cannot help: on a UNC share there is no bin
  (`scripts/recycle-bin.ps1` refuses it), so prevention is the whole remedy.
  Record:
  [docs/incidents/2026-11-14-full-file-rewrite-truncation.md](docs/incidents/2026-11-14-full-file-rewrite-truncation.md).

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
- Overwrites that do not read the file first (`echo x > notes.md`,
  `Invoke-WebRequest -OutFile`, `git checkout --`). Those are deliberate rewrites,
  not read-modify-write: the new content does not depend on the old, and refusing
  them would mean refusing `write`/`edit` too. README 「不挡什么」 lists them.
- Post-hoc rollback. There is no "compare the size afterwards and restore": the
  old bytes are needed *before* the write, `tools/post-execute` can only turn a
  result into feedback, and a per-call tree snapshot is O(workspace) and would
  still miss a target outside the workspace.
- A rule that asks. `{ kind: 'ask' }` resolves to allow in the same tick wherever
  approvals are auto-granted — the default for unattended deployments — so this
  plugin denies rather than asks. A rule that only looks present is worse than no
  rule.
- Staging a share delete is a *copy*, not an image: ACLs, alternate data streams,
  sparse ranges and ownership are not reproduced (timestamps are), and the
  verification compares entry sets, kinds and sizes rather than hashes. Content
  recovery is the goal; a byte-for-byte clone is not what you get. The cost is also
  honest: O(size) in time and the same in free space on the staging volume, so a
  very large tree can exceed the tool call's timeout.

## Why there is no permanent-delete tool

Issue #2 asks for one: a tool that really erases when the user asked for it,
gated by a `user_request` / `user_quote` field. It is refused, and the reason is
not that permanent deletion is never legitimate — a user can always do it in
Explorer, or run a script themselves. The reason is that **the gate would be
authored by the thing it is meant to guard.**

Three layers, and only the first has a machine judge:

| Layer | Question | Judge |
| --- | --- | --- |
| 1 | did these characters come from the user? | the plugin, mechanically — `source.kind === 'user'` plus an `rpcId` on the `user/message` event |
| 2 | does that sentence mean "this file may be destroyed"? | nobody, automatically |
| 3 | should it run *now*? | a human — `{ kind: 'ask' }` where approvals are real; on a box with `approval policy: never` that resolves to allow, so the only remaining human gate is a command the person runs |

A verbatim quote can be checked. Intent cannot, because **the same characters
carry both readings**: "永久删除 a.md", "不要永久删除 a.md", "别永久删除 a.md",
"能永久删除 a.md 吗", "你上次说的『永久删除 a.md』是指哪一步" all contain the
affirmative token, and the last three are not instructions at all. A lexical
filter over negations is an enumeration treadmill, and it fails in the direction
of *allowing* — the token is present — which for a destructive action is the worst
direction to fail in. Adding a semantic model to classify the sentence only moves
the trust question up one level. (Even the provenance check needs care: `user/message`
also carries `agent-instructions` from `AGENTS.md`, `runtime-context` and spliced
agent input, so a filter that does not key on `source.kind` would let the agent
author its own permission slip.)

**Measured, on why the surrounding design cannot compensate.** 126 real guard
denials across 58 sessions (300 newest session logs on this machine, 2026-11-24),
classified by what the model did before the next user turn:

| follow-up | share |
| --- | --- |
| changed approach (typically by following the recipe the deny message names: copy to `.bak`, use `edit`) | 78% |
| `file_trash` within 5 tool calls | 14% |
| re-attempted a shape the guard would block | 4% |
| diagnosed first (`read`, `grep`, `Test-Path`) | 3% |
| wrote a delete into a script and ran that path | 0.8% |
| **stopped without another tool call** | **0%** |

A block does not end a turn; it re-routes. And the re-route follows the
alternative the deny message names — which is why every refusal here names one.
There is no acceptable alternative for "make it unrecoverable", so a
`permanent_delete` tool would be the shortest path to a goal the model had already
been told to pursue, with a fabricated-or-misapplied quote as its receipt.

**What would be honest**, if this is ever revisited: the gate is a real approval or
a command the human runs (`scripts/purge-bin-entry.ps1`, keyed off the `$I` record),
and `user_quote` is an audit field — never the key. Anything else is an audited
permanent delete with a receipt the agent wrote itself.

Note the asymmetry: "no permanent delete" is a policy, not an invariant — `Add-Type`
C# still reaches `DeleteFileW`, as the README's 「不挡什么」 table says. The choice
above keeps the *easy* path safe, which is what a policy layer can actually do.

## How the rules were calibrated (2026-11-25)

The rules from 2.3.0 / 2.4.0 each came from one incident. 2.4.2 came from a
measurement: **62,131 shell commands that actually ran on this machine** (5,746 session
logs), re-classified with the matcher as it stood. 1,580 would be refused; **432 of those
were false positives (0.70% of every command ever run here)**. Records:
`docs/incidents/2026-11-24-rule-false-positive-sweep.md` (evidence) and
`docs/incidents/2026-11-24-fix-plan-2-4-2.md` (plan, including the direction that was
rejected and why).

Two things from that exercise are worth keeping in view when changing a rule:

**1. A shape list is the same mistake as a verb list.** The first proposal was to refuse
only commands containing a discard token (`[a..b]`, `-First`, `Select-Object`). Measurements
saw four rebuilds that contain none of them and destroy a whole file anyway
(`| Where-Object { -not … }`, `for { … continue }`, `-replace '(?s)^.*$'`). The rule keeps
"reads the same file it writes" as its shape and adds **order** and **recoverability** —
it does not trade one word list for another.

**2. A count is not a shape.** After the change the sweep's `real` count fell 1,148 → 852,
which reads like 296 dangerous commands were let through. A mechanical check said otherwise:
across the 5,917 commands now allowed, **none** are "same file, read before write". The drop
was the sweep's own classifier mislabeling write-then-read-back as a whole-file rewrite. The
acceptance criteria were rewritten as a shape gate because of this.

**3. A dry run must not become an instruction.** `Remove-Item x -WhatIf` classified as
`rewrite`, and the rewrite branch tells the model to re-run the call as `file_trash` — so a
user asking to preview was advised to destroy the file. Dry runs are now rendered as
previews. The tempting fix (drop `-WhatIf` statements from classification) was measured and
rejected: the word in a comment or a string then exempts a real write.

## Reporting

Once this repository is public, use a GitHub Security Advisory (or a private
message to the maintainer) rather than a public issue for anything that lets a
recognised delete bypass the Recycle Bin.

Please include: the exact command text, which tool carried it, the DSH version,
and whether the target was on NTFS, a UNC path, or another file system. Do not
paste real paths from a private machine — reduce them to the smallest form that
still reproduces the behaviour.
