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
    <#  Resolve to an absolute path without requiring existence.  #>
    param([Parameter(Mandatory)][string] $Path)
    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
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
    <#  Map the documented SHFileOperation error codes to something readable.  #>
    param([Parameter(Mandatory)][int] $Code)
    # A bare `switch` statement with explicit `return`s: `return switch (...) { ... }`
    # is a parse error on this pwsh build ("unexpected token '{'").
    switch ($Code) {
        0x2  { return 'The path no longer exists.' }
        0x3  { return 'The directory does not exist.' }
        0x71 { return 'The source and destination are the same.' }
        0x72 { return 'The operation was cancelled.' }
        0x74 { return 'The path is too long.' }
        0x75 { return 'The destination is a subfolder of the source.' }
        0x76 { return 'The operation is not supported.' }
        0x78 { return 'Access was denied.' }
        0x79 { return 'The operation was aborted.' }
        0x7A { return 'The source is in use by another process.' }
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
    if ($rc -ne 0) { return (Get-ShFileOperationMessage -Code $rc) }
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
