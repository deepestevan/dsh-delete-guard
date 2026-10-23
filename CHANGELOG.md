# Changelog

All notable changes to this plugin. Dates are the day the tarball was packed on
this machine (`temp/pack/dsh-delete-guard-<ver>.tgz`), which is the artifact
each profile actually ran.

The long-form reasoning behind every entry — what was measured, what was
rejected, what the trade-off costs — lives in the maintainer's engineering notes (`INCIDENTS.md`, not shipped since 2.2.0).

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
