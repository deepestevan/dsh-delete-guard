<#
.SYNOPSIS
  Recycle Bin bridge for the dsh-delete-guard plugin.

.DESCRIPTION
  Reads one JSON request from stdin and writes one JSON response to stdout.

  Requests:
    { "op": "recycle",  "paths": ["C:\\a\\b.txt", ...] }
    { "op": "usage",    "drive": "C:" }
  Responses:
    { "recycled": [...], "failures": [{ "path": "...", "error": "..." }] }
    { "items": 12, "bytes": 345678 }
    { "freeBytes": 99999999 }

  The recycle operation uses SHFileOperationW with FOF_ALLOWUNDO, the same
  Win32 path Explorer uses, so the bin's $I/$R metadata is written correctly.
  A failed move is reported, never silently escalated to a permanent delete.
  Paths whose volume has no bin at all (UNC shares, exFAT/FAT32 volumes) are
  refused before the call: SHFileOperationW would erase them and return 0.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# stdin/stdout are UTF-8 by contract with the Node bridge in lib/recycle.js.
# [Console]::InputEncoding is NOT UTF-8 here: it follows the OEM code page (936
# on a zh-CN box), so reading through [Console]::In decodes the incoming UTF-8
# bytes as GBK. Every non-ASCII path then arrives as mojibake (UTF-8 bytes
# reinterpreted as GBK), and the shell rejects the whole batch as invalid.
# Decode the raw standard-input stream explicitly instead of trusting the
# console's configured code page.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

# --- Win32 interop -----------------------------------------------------------

if (-not ('RecycleBinNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 8)]
public struct SHFILEOPSTRUCTW
{
    public IntPtr hwnd;
    public uint   wFunc;
    [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
    [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
    public ushort fFlags;
    public bool   fAnyOperationsAborted;
    public IntPtr hNameMappings;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
}

[StructLayout(LayoutKind.Sequential)]
public struct SHQUERYRBINFO
{
    public int  cbSize;
    public long i64Size;
    public long i64NumItems;
}

public static class RecycleBinNative
{
    public const uint FO_DELETE    = 0x0003;
    public const ushort FOF_SILENT         = 0x0004;
    public const ushort FOF_NOCONFIRMATION = 0x0010;
    public const ushort FOF_ALLOWUNDO      = 0x0040;
    public const ushort FOF_NOERRORUI      = 0x0400;

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int SHFileOperationW(ref SHFILEOPSTRUCTW lpFileOp);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int SHQueryRecycleBinW(string pszRootPath, ref SHQUERYRBINFO pSHQueryRBInfo);
}
'@ -ErrorAction Stop
}

# --- Helpers -----------------------------------------------------------------

function Write-Json {
    param([Parameter(Mandatory)] $Object)
    $json = $Object | ConvertTo-Json -Depth 6 -Compress
    [Console]::Out.Write($json)
}

function Resolve-NormalizedPath {
    <#
      Resolve to an absolute path without requiring existence, and drop a literal
      `\\?\` prefix.

      The prefix has one legitimate use — naming a path longer than MAX_PATH, or one
      whose name Win32 would otherwise trim — and callers do hand it over. But
      SHFileOperationW does not accept it: measured 2026-11-25, a `\\?\`-prefixed
      file returns 0x7C (DE_INVALIDFILES) where the same file without the prefix
      recycles. And a path over 260 characters recycles fine *without* the prefix, so
      stripping loses nothing.

      Left in place, the prefix was worse than useless: Test-RecyclableVolume matched
      `\\*` and reported "a network location has no Recycle Bin" for a local path.

      `\\?\UNC\host\share\x` becomes the ordinary UNC spelling, which is then judged
      as the network location it is.
    #>
    param([Parameter(Mandatory)][string] $Path)

    $text = $Path
    if ($text.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $text = '\\' + $text.Substring(8)
    } elseif ($text.StartsWith('\\?\', [System.StringComparison]::Ordinal)) {
        $text = $text.Substring(4)
    }

    $expanded = [Environment]::ExpandEnvironmentVariables($text)
    $full = [System.IO.Path]::GetFullPath($expanded)
    # GetFullPath keeps a trailing separator on directories; SHFileOperationW
    # requires a double-null terminated list and tolerates either form, but a
    # single canonical form keeps the response comparable to the request.
    return $full.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Get-DriveRoot {
    param([string] $Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $env:SystemDrive + '\' }
    try {
        $root = [System.IO.Path]::GetPathRoot((Resolve-NormalizedPath -Path $Path))
        if ([string]::IsNullOrEmpty($root)) { return $env:SystemDrive + '\' }
        return $root
    } catch {
        return $env:SystemDrive + '\'
    }
}

# --- Operations --------------------------------------------------------------

function Get-ShFileOperationMessage {
    <#
      Map the documented SHFileOperation error codes to something readable.

      0x2 is deliberately **not** "the path no longer exists": measured 2026-11-25, a
      directory whose contents include a name Win32 cannot address returns 0x2 while
      the path is right there. The code means "one of the files it needed was not
      found", and Get-FailureDiagnosis appends which one. The wording below says only
      what the code supports.
    #>
    param([Parameter(Mandatory)][int] $Code)
    # A bare `switch` statement with explicit `return`s: `return switch (...) { ... }`
    # is a parse error on this pwsh build ("unexpected token '{'").
    switch ($Code) {
        0x2  { return 'A file in that path could not be found.' }
        0x3  { return 'A directory in that path could not be found.' }
        0x20 { return 'Access is denied.' }
        0x71 { return 'The source and destination are the same.' }
        0x72 { return 'The operation was cancelled.' }
        0x74 { return 'The path is too long.' }
        0x75 { return 'The destination is a subfolder of the source.' }
        0x76 { return 'The operation is not supported.' }
        0x78 { return 'Access was denied.' }
        0x79 { return 'The operation was aborted.' }
        0x7A { return 'The source is in use by another process.' }
        0x7B { return 'The path is invalid.' }
        0x7C { return 'The path is invalid.' }
        default { return ("SHFileOperationW failed with code 0x{0:X}" -f $Code) }
    }
}

function Test-RecyclableVolume {
    <#
      Can this path's volume actually absorb a recycle?

      The Recycle Bin is a per-volume NTFS facility. On a UNC path, or on a
      volume whose file system has no bin store (exFAT / FAT32), SHFileOperationW
      with FOF_ALLOWUNDO + FOF_NOCONFIRMATION + FOF_SILENT does **not** fail: it
      erases the item and returns 0. The post-check in Invoke-RecycleOne only
      proves the path is gone, which is exactly what a permanent delete looks
      like. Reproduced 2026-10-23 on a UNC share: file gone, no $I/$R record on
      any local volume, SHQueryRecycleBin unchanged — and the tool had reported
      "Moved to the Recycle Bin". Refuse up front instead; refusing is the whole
      contract of this plugin.

      Returns $null when the path can be recycled, otherwise the refusal text.
    #>
    param([Parameter(Mandatory)][string] $Path)

    if ($Path -like '\\*') {
        return 'A network location has no Recycle Bin, so recycling here would erase the item permanently. Copy it to a local NTFS path first, or delete it from Explorer where Windows can warn the user.'
    }
    $root = Get-DriveRoot -Path $Path
    $format = ''
    try { $format = ([System.IO.DriveInfo]::new($root)).DriveFormat } catch { $format = '' }
    if ($format -eq 'NTFS' -or $format -eq 'ReFS') { return $null }
    $shown = if ([string]::IsNullOrWhiteSpace($format)) { 'unknown' } else { $format }
    return "Volume $root has no Recycle Bin (file system: $shown), so recycling here would erase the item permanently. Move it to an NTFS volume first, or delete it from Explorer where Windows can warn the user."
}

function Get-NamesWin32CannotAddress {
    <#
      Find entries whose name Windows will not resolve when handed as a path.

      A name ending in a space or a dot can exist on NTFS — WSL, a zip extractor, a
      sync client or a port of a POSIX tool can create it — but Win32 trims those
      trailing characters when the name is written into a path, so `Open` looks for a
      name that is not there. That is why a directory holding such a child cannot be
      recycled as a whole: SHFileOperationW walks the tree, the child's own open fails
      with ERROR_FILE_NOT_FOUND, and the whole operation returns 0x2 even though the
      path plainly exists.

      The listing itself has to go through `\\?\` — that prefix is the only spelling in
      which the name is taken literally. The prefix is used *here and only here*, to
      read names; SHFileOperationW is never handed one (it returns 0x7C for those).

      Returns up to `Limit` offending entries as `relative/path` strings, each with a
      reason, so the message can name them.
    #>
    param(
        [Parameter(Mandatory)][string] $Path,
        [int] $Limit = 8
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return @() }

    $found = [System.Collections.Generic.List[object]]::new()
    $queue = [System.Collections.Generic.Queue[string]]::new()
    $queue.Enqueue($Path)

    while ($queue.Count -gt 0 -and $found.Count -lt $Limit) {
        $current = $queue.Dequeue()

        # Listing through the literal prefix, so a malformed name is returned as itself
        # instead of being silently trimmed to a sibling that may not exist.
        $literal = if ($current.StartsWith('\\')) { '\\?\UNC\' + $current.Substring(2) } else { '\\?\' + $current }
        $entries = $null
        try {
            $entries = [System.IO.Directory]::GetFileSystemEntries($literal)
        } catch {
            # A tree we cannot enumerate is not this diagnostic's problem; the caller
            # still reports the original failure.
            return $found
        }

        foreach ($entry in $entries) {
            if ($found.Count -ge $Limit) { break }

            # The literal listing returns names with the prefix attached.
            $name = [System.IO.Path]::GetFileName($entry)
            $reason = $null
            if ($name.EndsWith(' ')) { $reason = 'ends with a space' }
            elseif ($name.EndsWith('.')) { $reason = 'ends with a dot' }
            elseif ($name -match '[\x00-\x1F]') { $reason = 'contains a control character' }

            if ($null -ne $reason) {
                $relative = $entry
                foreach ($prefix in @('\\?\UNC\', '\\?\')) {
                    if ($relative.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
                        $relative = $relative.Substring($prefix.Length)
                        break
                    }
                }
                $found.Add([pscustomobject]@{ path = $relative; reason = $reason })
            }

            $isDirectory = $false
            try { $isDirectory = [System.IO.Directory]::Exists($entry) } catch { $isDirectory = $false }
            if ($isDirectory -and -not ($name.EndsWith(' ') -or $name.EndsWith('.'))) {
                $queue.Enqueue($entry)
            }
        }
    }

    return $found.ToArray()
}

function Get-FailureDiagnosis {
    <#
      Turn a bare SHFileOperation failure into something a caller can act on.

      Measured 2026-11-25. Two failures are worth diagnosing, because both used to
      produce a message that pointed the caller at the wrong thing:

      0x2  DE_FILENOTFOUND — the message said "the path no longer exists" while the
           path was right there. The real cause was a child whose name Win32 cannot
           address (trims a trailing space or dot), so the tree could not be walked.
      0x20 DE_ACCESSDENIED  — a directory held as some process's working directory, or
           an open file inside it. Every file inside can be deleted; the directory
           itself cannot, and the shell reports access denied with no hint of who holds
           it. Enumerating handles needs elevation, so this reports what is observable
           and says so rather than guessing a PID.

      Returns extra text to append to the message, or $null.
    #>
    param(
        [Parameter(Mandatory)][int] $Code,
        [Parameter(Mandatory)][string] $Path
    )

    $exists = $false
    try { $exists = Test-Path -LiteralPath $Path } catch { $exists = $false }

    if ($Code -eq 0x2) {
        if (-not $exists) {
            return 'The path is not there now — something else removed it between the check and the call.'
        }
        $bad = Get-NamesWin32CannotAddress -Path $Path
        if ($bad.Count -eq 0) {
            return $null
        }
        $shown = ($bad | ForEach-Object { "$($_.path) ($($_.reason))" }) -join '; '
        $more = if ($bad.Count -ge 8) { ' (listing stopped at 8)' } else { '' }
        # One expression, not several lines joined with `+`: a `return` ends the
        # statement at the line break, so a trailing `+` continuation would return
        # only the first fragment and silently drop the rest.
        $text = "The path exists, but it contains entries Windows cannot open by name: $shown$more. "
        $text += 'Win32 trims a trailing space or dot when a name is written into a path, so the tree cannot be walked. '
        $text += 'Renaming those entries to names without a trailing space or dot makes the directory recyclable; '
        $text += 'they are usually left by WSL, an archive extractor or a sync client. '
        $text += 'This tool does not rename or delete inside a directory it was asked to delete.'
        return $text
    }

    if ($Code -eq 0x20 -or $Code -eq 0x78 -or $Code -eq 0x7A) {
        if (-not $exists) { return $null }
        # The base message already says "access is denied"; start from the meaning.
        $text = 'For a directory this usually means a process is using it: its working directory is set '
        $text += 'to this path, or it holds one of the files inside open. Every file inside can still be '
        $text += 'deleted individually; the directory itself cannot until that process lets go. '
        $text += 'This tool does not enumerate which process holds it — that needs elevation or handle-scanning, '
        $text += 'and it will not guess. If you need the holder, check for a process started in this directory '
        $text += '(a Python environment, a build or a shell whose cwd is here), or retry after it exits.'
        return $text
    }

    return $null
}


function Invoke-RecycleOne {
    <#
      Recycle a single path.

      SHFileOperationW takes a whole double-null-terminated list and applies it
      as one transaction: a single unusable entry makes the call fail wholesale,
      with no way to tell which entry was at fault. Calling it per path keeps
      one bad operand from turning a good batch into a total failure, and makes
      each reported error belong to the path it names.

      Returns $null on success, otherwise the error text for this path.
    #>
    param([Parameter(Mandatory)][string] $Path)

    $refusal = Test-RecyclableVolume -Path $Path
    if ($null -ne $refusal) { return $refusal }

    $op = New-Object SHFILEOPSTRUCTW
    $op.wFunc  = [RecycleBinNative]::FO_DELETE
    $op.pFrom  = $Path + "`0`0"
    $op.pTo    = $null
    $op.fFlags = [ushort](
        [RecycleBinNative]::FOF_ALLOWUNDO -bor
        [RecycleBinNative]::FOF_NOCONFIRMATION -bor
        [RecycleBinNative]::FOF_SILENT -bor
        [RecycleBinNative]::FOF_NOERRORUI
    )

    $rc = [RecycleBinNative]::SHFileOperationW([ref]$op)
    if ($rc -ne 0) {
        $message = Get-ShFileOperationMessage -Code $rc
        $diagnosis = Get-FailureDiagnosis -Code $rc -Path $Path
        if ($null -ne $diagnosis) { return "$message $diagnosis" }
        return $message
    }
    if ($op.fAnyOperationsAborted) { return 'The shell aborted the move to the Recycle Bin.' }
    # The call reports success for the whole request; confirm this path actually left.
    if (Test-Path -LiteralPath $Path) { return 'The path still exists after the recycle operation.' }
    return $null
}

function Invoke-Recycle {
    param([Parameter(Mandatory)] $Request)

    $recycled = [System.Collections.Generic.List[string]]::new()
    $failures = [System.Collections.Generic.List[object]]::new()

    $rawPaths = @($Request.paths)
    foreach ($p in $rawPaths) {
        if ($null -eq $p -or ([string]$p).Trim().Length -eq 0) { continue }

        $resolved = $null
        try {
            $resolved = Resolve-NormalizedPath -Path ([string]$p)
        } catch {
            $failures.Add(@{ path = [string]$p; error = "unresolvable path: $($_.Exception.Message)" })
            continue
        }

        $error = Invoke-RecycleOne -Path $resolved
        if ($null -eq $error) {
            $recycled.Add($resolved)
        } else {
            $failures.Add(@{ path = $resolved; error = $error })
        }
    }

    Write-Json @{ recycled = $recycled; failures = $failures }
}

function Invoke-Usage {
    param([Parameter(Mandatory)] $Request)

    $drive = if ($Request.PSObject.Properties.Name -contains 'drive' -and $Request.drive) { [string]$Request.drive } else { $env:SystemDrive }
    if ($drive -notmatch '\\$') { $drive = $drive + '\' }

    $info = New-Object SHQUERYRBINFO
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][SHQUERYRBINFO])
    $rc = [RecycleBinNative]::SHQueryRecycleBinW($drive, [ref]$info)
    if ($rc -ne 0) {
        Write-Json @{ items = 0; bytes = 0; error = "SHQueryRecycleBinW failed with code 0x$('{0:X}' -f $rc)" }
        return
    }
    Write-Json @{ items = [int64]$info.i64NumItems; bytes = [int64]$info.i64Size }
}

# There is deliberately no `capacity` op. On an NTFS volume the bin is on the
# same volume as the item, so a recycle is a rename and frees nothing — a
# free-space gate would refuse harmless deletes and let harmful ones through.
# What this bridge checks instead is whether the volume has a bin at all
# (Test-RecyclableVolume), which is the difference between a recycle and an
# erase.

# --- Entry point -------------------------------------------------------------

try {
    $reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $Utf8NoBom, $false)
    $stdin = $reader.ReadToEnd()
    $reader.Dispose()
    if ([string]::IsNullOrWhiteSpace($stdin)) {
        Write-Json @{ error = 'empty request' }
        exit 0
    }
    $request = $stdin | ConvertFrom-Json

    switch ([string]$request.op) {
        'recycle'  { Invoke-Recycle  -Request $request }
        'usage'    { Invoke-Usage    -Request $request }
        default    { Write-Json @{ error = "unknown op: $($request.op)" } }
    }
} catch {
    Write-Json @{ error = $_.Exception.Message }
}
