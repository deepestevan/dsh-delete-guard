/**
 * Windows Recycle Bin bridge.
 *
 * Moving a file to the Recycle Bin is not a rename: the shell maintains a
 * per-volume `$Recycle.Bin\<sid>\` store plus `$I`/`$R` metadata pairs. Doing
 * that by hand is how people corrupt the bin. So this module does not
 * reimplement it — it shells out to the same Win32 API Explorer uses
 * (`SHFileOperationW` with `FOF_ALLOWUNDO`) via a generated PowerShell script.
 *
 * Capacity is reported with `SHQueryRecycleBin`. There is deliberately no
 * free-space pre-check: on an NTFS volume the bin lives on the same volume as
 * the item, so a recycle is a rename and consumes no space — a "do you have
 * room" gate would only refuse harmless deletes. What must be checked up front
 * is whether the volume *has* a bin at all: see Test-RecyclableVolume in the
 * PowerShell bridge (UNC and exFAT/FAT32 paths are refused, because
 * SHFileOperationW erases there and still reports success).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the PowerShell bridge script. */
export const BRIDGE_SCRIPT = join(HERE, '..', 'scripts', 'recycle-bin.ps1');

/**
 * Candidate PowerShell executables, most capable first.
 * @returns the resolved executable path, or `pwsh` as a PATH-resolved fallback.
 */
export function resolvePowershell() {
  const candidates = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\6\\pwsh.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft\\WindowsApps\\pwsh.exe'),
  ];
  for (const candidate of candidates) {
    if (candidate.length > 0 && existsSync(candidate)) return candidate;
  }
  return 'pwsh.exe';
}

/**
 * Run the bridge script with a JSON request on stdin and parse its JSON reply.
 *
 * The script is invoked with `-NoProfile -NonInteractive` so a user profile
 * cannot change behaviour. stdout carries exactly one JSON document.
 *
 * @param request - the bridge request object.
 * @param options - `signal` for cancellation, `timeoutMs` for a hard deadline.
 * @returns the parsed bridge response.
 * @throws when the process fails to start, times out, or emits malformed JSON.
 */
export function callBridge(request, options = {}) {
  const { signal, timeoutMs = 120_000 } = options;
  const exe = resolvePowershell();

  return new Promise((resolve, reject) => {
    const child = spawn(
      exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE_SCRIPT],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      fn(value);
    };

    const onAbort = () => {
      child.kill();
      const error = new Error('recycle-bin bridge aborted');
      error.name = 'AbortError';
      finish(reject, error);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`recycle-bin bridge timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      finish(reject, new Error(`failed to launch PowerShell (${exe}): ${error.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      const text = stdout.trim();
      if (text.length === 0) {
        finish(
          reject,
          new Error(`recycle-bin bridge produced no output (exit ${code}). stderr: ${stderr.trim()}`),
        );
        return;
      }
      try {
        finish(resolve, JSON.parse(text));
      } catch (error) {
        finish(
          reject,
          new Error(`recycle-bin bridge returned malformed JSON: ${error.message}. raw: ${text.slice(0, 500)}`),
        );
      }
    });

    child.stdin.on('error', () => {
      /* The child may exit before reading stdin; the close handler reports. */
    });
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}

/**
 * Move paths into the Recycle Bin.
 *
 * @param paths - file or directory paths to recycle.
 * @param options - `signal` for cancellation.
 * @returns `{ recycled, failures }` with per-path outcomes.
 */
export async function recyclePaths(paths, options = {}) {
  if (paths.length === 0) return { recycled: [], failures: [] };
  const response = await callBridge(
    { op: 'recycle', paths },
    { signal: options.signal },
  );
  return {
    recycled: Array.isArray(response.recycled) ? response.recycled : [],
    failures: Array.isArray(response.failures) ? response.failures : [],
  };
}

/**
 * Query Recycle Bin occupancy for one volume.
 *
 * @param drive - a drive letter like `C:`; defaults to the system drive.
 * @param options - `signal` for cancellation.
 * @returns `{ items, bytes }`.
 */
export async function recycleBinUsage(drive, options = {}) {
  const response = await callBridge(
    { op: 'usage', drive },
    { signal: options.signal },
  );
  return {
    items: typeof response.items === 'number' ? response.items : 0,
    bytes: typeof response.bytes === 'number' ? response.bytes : 0,
  };
}
