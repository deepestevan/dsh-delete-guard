/**
 * dsh-delete-guard — force every DSH file deletion through the OS Recycle Bin.
 *
 * Where this hooks
 * ----------------
 * `tools/pre-execute` (a waterfall on `ctx.tools`). That is the seam DSH 0.1.7
 * actually routes every model tool call through, and `PreToolDecision` there can
 * return `{ kind: 'deny' }`.
 *
 * It deliberately does NOT monkey-patch the shell executor. `ctx.shell` in 0.1.7
 * is a `ShellExecutor` with only `resolve()` and `execute()`; there is no
 * `run()`/`start()` to wrap, so a wrapper installed there is never consulted and
 * every delete proceeds unguarded while appearing protected.
 *
 * What it does with a delete
 * --------------------------
 * A recognised delete is not merely denied: the operands are parsed out and the
 * call is denied with a message instructing the model to re-issue the deletion
 * through the `file_trash` tool this plugin registers, which performs a real
 * `SHFileOperationW(FOF_ALLOWUNDO)` move. Pre-execute cannot rewrite arguments
 * (`ToolExecution.arguments` is frozen and already logged), so denial plus a
 * redirect is the correct shape.
 *
 * Known limits, stated honestly
 * -----------------------------
 * A delete executed *inside* a script body is not rewritten. `blockScriptDeletes`
 * denies inline `-Command`/`-File`/`-e` invocations that contain delete verbs,
 * but a script file whose contents the guard never sees can still erase data if
 * the model writes one and runs it by a path that contains no delete verb. The
 * system-prompt section asks the model not to; that part is guidance, not a
 * guarantee.
 */

import { stat } from 'node:fs/promises';
import { classifyCommand } from './guard.js';
import { recyclePaths, recycleBinUsage } from './recycle.js';
import { validateTrashTarget, workspaceRootReason } from './move-guard.js';

export const name = 'delete-guard';
export const inject = ['tools', 'systemPrompt'];

/** Tool name the model must use for every deletion. */
const TRASH_TOOL = 'file_trash';
/** Tool name for reporting recycle-bin state. */
const STATUS_TOOL = 'trash_status';
/** System-prompt section identifier. */
const PROMPT_SECTION = 'delete-guard';
/** Ordering hint for the prompt section. */
const PROMPT_ORDER = 60;

/**
 * Tools that carry a shell command, and where the command text lives.
 *
 * The guard used to look at `pwsh` and `bash` only, which left DSH's persistent
 * terminal uncovered: `terminal_send` types a command into a live PTY, so it
 * never passes through either shell tool. Measured 2026-10-23 in this install —
 * `terminal_send` ran `Remove-Item …` while the guard sat on the same call path
 * and said nothing.
 *
 * `dialect` decides two rules: `$( … )` opacity (pwsh-only) and POSIX path
 * translation (bash-only). A terminal session does not say which shell it is, so
 * it is judged as `pwsh` — that refuses more, not less.
 */
const SHELL_TOOLS = new Map([
  ['pwsh', { field: 'command', dialect: 'pwsh' }],
  ['powershell', { field: 'command', dialect: 'pwsh' }],
  ['cmd', { field: 'command', dialect: 'pwsh' }],
  ['bash', { field: 'command', dialect: 'bash' }],
  ['sh', { field: 'command', dialect: 'bash' }],
  ['zsh', { field: 'command', dialect: 'bash' }],
  ['shell', { field: 'command', dialect: 'bash' }],
  ['terminal_send', { field: 'text', dialect: 'pwsh' }],
  ['terminal_write', { field: 'text', dialect: 'pwsh' }],
]);

/**
 * Reject an empty path list before any I/O.
 * @param paths - candidate paths.
 * @returns the non-empty trimmed list.
 */
function cleanPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths
    .filter((p) => typeof p === 'string')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Resolve the workspace root the sandbox policy reports, falling back to the
 * process working directory. The fallback matters: without a sandbox service
 * the `file_trash` path would have no root to compare against, and the guard
 * would silently lose its workspace check.
 * @param ctx - the Cordis context.
 * @returns an absolute path, or `undefined` when nothing resolved.
 */
function resolveWorkspaceRoot(ctx) {
  try {
    const value = ctx.sandboxPolicy?.resolve?.({})?.workspaceRoot;
    if (typeof value === 'string' && value.trim().length > 0) return value;
  } catch {
    // Absent or misbehaving policy service: fall back rather than skip the check.
  }
  return process.cwd();
}

/**
 * Plugin entry point.
 * @param ctx - the Cordis context.
 * @param config - plugin configuration.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return;

  const {
    blockDestructiveCommands = true,
    forbidEmptyRecycleBin = true,
    forbidWipe = true,
    blockScriptDeletes = true,
  } = config;

  const guardOptions = { forbidEmptyRecycleBin, forbidWipe, blockScriptDeletes };
  const workspaceRoot = resolveWorkspaceRoot(ctx);

  // --- 1. Intercept destructive shell commands ------------------------------

  if (blockDestructiveCommands) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      // Only the tools that carry a shell command: the two shell tools plus the
      // persistent terminal, which types into a live PTY.
      const spec = SHELL_TOOLS.get(exec.name);
      if (spec === undefined) return next();

      const args = exec.arguments;
      if (args === null || typeof args !== 'object') return next();
      const command = args[spec.field];
      if (typeof command !== 'string') return next();

      const verdict = classifyCommand(command, {
        ...guardOptions,
        // The tool name identifies the shell language, which decides
        // dialect-scoped rules such as `$( … )` and POSIX path translation.
        dialect: spec.dialect,
      });

      if (verdict.action === 'allow') return next();

      if (verdict.action === 'deny') {
        return {
          kind: 'deny',
          reason: verdict.reason,
          info: { name: 'DeleteGuardError', code: `DELETE_GUARD_${verdict.kind.toUpperCase()}` },
        };
      }

      // action === 'rewrite': steer the model to the recoverable path.
      const list = verdict.targets.map((t) => `"${t}"`).join(', ');
      return {
        kind: 'deny',
        reason:
          `The recycle-bin guard blocked this delete. Deleting through the shell erases files permanently, ` +
          `so all deletions must go through the ${TRASH_TOOL} tool, which moves them to the OS Recycle Bin ` +
          `where they stay recoverable.\n\n` +
          `Re-run this as:  ${TRASH_TOOL} with paths = [${list}]\n\n` +
          `If those paths are wrong or you meant a different target, read the directory first and re-issue ` +
          `the call with explicit literal paths.`,
        info: { name: 'DeleteGuardError', code: 'DELETE_GUARD_REWRITE' },
      };
    });
  }

  // --- 2. The tool the model must use instead -------------------------------

  ctx.tools.register({
    name: TRASH_TOOL,
    description:
      'Delete files or directories by moving them to the OS Recycle Bin, where they remain recoverable. ' +
      'This is the only permitted way to delete anything. Never use pwsh/bash with Remove-Item, del, rm, rd or rmdir. ' +
      'The operation fails loudly rather than falling back to a permanent erase.',
    // `ctx.tools.register` passes parameters through verbatim (only `defineTool`
    // compiles the flat DSL), so hand-write standard JSON Schema here — the
    // model endpoint rejects the un-compiled flat map with 11129.
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paths: {
          type: 'array',
          description: 'Absolute or workspace-relative paths to move to the Recycle Bin.',
          items: { type: 'string' },
        },
        reason: {
          type: 'string',
          description: 'Optional short note on why these paths are being deleted.',
        },
      },
      required: ['paths'],
    },
    output: {
      // Raw JSON Schema (not the authoring DSL): `required` is an object-only
      // key here. It must be an array of property names on the object, never a
      // per-node flag — the host rejects `required` on array/string nodes.
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['recycled', 'failures'],
        properties: {
          recycled: { type: 'array', items: { type: 'string' } },
          failures: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'error'],
              properties: {
                path: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [];
        if (value.recycled.length > 0) {
          lines.push(`Moved to the Recycle Bin (${value.recycled.length}):`);
          for (const p of value.recycled) lines.push(`  ${p}`);
        }
        if (value.failures.length > 0) {
          lines.push(`Failed (${value.failures.length}):`);
          for (const f of value.failures) lines.push(`  ${f.path}: ${f.error}`);
        }
        if (lines.length === 0) lines.push('Nothing was deleted: no usable paths were provided.');
        lines.push('');
        lines.push('These items are recoverable from the Recycle Bin; they were not permanently erased.');
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const paths = cleanPaths(args.paths);
      if (paths.length === 0) {
        return {
          recycled: [],
          failures: [{ path: '(none)', error: 'no usable paths were supplied' }],
        };
      }

      const cwd = exec.agent?.session?.cwd ?? process.cwd();

      // The shell-side guard can only police deletes the model runs through
      // pwsh/bash. A direct file_trash call has no command text to scan, so the
      // operands are policed here: resolve each one, refuse the filesystem
      // roots whose Recycle Bin store lives inside them, and refuse the session
      // workspace root. See move-guard.js for why a "recoverable" excuse does
      // not cover these.
      const absolute = [];
      const failures = [];
      for (const raw of paths) {
        const verdict = validateTrashTarget(raw, cwd);
        if (!verdict.ok) {
          failures.push({ path: raw, error: verdict.error });
          continue;
        }
        const rootReason = workspaceRootReason(verdict.path, workspaceRoot);
        if (rootReason !== undefined) {
          failures.push({ path: verdict.path, error: rootReason });
          continue;
        }
        // Verify existence up front so a typo is reported as a missing path
        // rather than as a shell-level failure.
        try {
          await stat(verdict.path);
          absolute.push(verdict.path);
        } catch {
          failures.push({ path: verdict.path, error: 'no such file or directory' });
        }
      }

      if (absolute.length === 0) {
        return { recycled: [], failures };
      }

      const result = await recyclePaths(absolute, { signal: exec.signal });
      return {
        recycled: result.recycled,
        failures: [...failures, ...result.failures],
      };
    },
  });

  // --- 3. Recycle-bin reporting --------------------------------------------

  ctx.tools.register({
    name: STATUS_TOOL,
    description:
      'Report how many items and bytes currently sit in the OS Recycle Bin for a drive. ' +
      'Use this to confirm deletions landed in the bin rather than being erased.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        drive: {
          type: 'string',
          description: 'Drive letter like "C:" or "D:". Defaults to the system drive.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['drive', 'items', 'bytes'],
        properties: {
          drive: { type: 'string' },
          items: { type: 'integer' },
          bytes: { type: 'integer' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          // `drive` already carries its colon when it came from the caller
          // (`F:`), so appending another one printed "Recycle Bin on F::".
          text: `Recycle Bin on ${String(value.drive).replace(/:+$/, '')}: ${value.items} item(s), ${formatBytes(value.bytes)}.`,
        },
      ],
    },
    async execute(args, exec) {
      const drive = typeof args.drive === 'string' && args.drive.trim().length > 0
        ? args.drive.trim()
        : undefined;
      const usage = await recycleBinUsage(drive, { signal: exec.signal });
      return { drive: drive ?? '(system drive)', items: usage.items, bytes: usage.bytes };
    },
  });

  // --- 4. System-prompt guidance -------------------------------------------

  try {
    ctx.systemPrompt.section({
      name: PROMPT_SECTION,
      order: PROMPT_ORDER,
      text: [
        '## Deletion policy: OS Recycle Bin only',
        '',
        `Every deletion must go through the \`${TRASH_TOOL}\` tool. It moves the target into the OS Recycle Bin,`,
        'so the user can recover it. Items deleted any other way are gone for good.',
        '',
        `- Do NOT run \`Remove-Item\`, \`del\`, \`erase\`, \`rd\`, \`rmdir\`, \`rm\`, \`unlink\` or \`rd\` through pwsh/bash.`,
        `  The recycle-bin guard blocks them and returns an error telling you to use \`${TRASH_TOOL}\`. That includes`,
        '  commands typed into a persistent terminal (`terminal_send`), which is judged the same way.',
        '- In a Git Bash session, pass paths to `file_trash` as Windows paths (`C:\\tmp\\x`), not POSIX ones.',
        '  `/c/tmp/x` is translated to `C:\\tmp\\x` for you; `~` and other mount points (`/tmp`, `/usr`) are refused.',
        '- Do NOT empty or modify the Recycle Bin (`Clear-RecycleBin` in any form — bare, `&`, inside a',
        '  child shell, or encoded; `SHEmptyRecycleBin`; driving the bin items\' own shell verbs; walking',
        '  `$Recycle.Bin`). All of those are blocked.',
        '- Restoring a deleted item is allowed: read the `$I` record under `C:\\$Recycle.Bin\\<SID>\\` for the',
        '  original path and move the paired `$R` file back. Do not use the bin items\' shell verbs to do it.',
        '- Do NOT use permanent-erase tools (`shred`, `sdelete`, `srm`, `cipher /w`). That is blocked.',
        '- Do NOT put deletions inside shell scripts or inline `-Command` / `-e` strings; they cannot be',
        '  routed to the Recycle Bin and will be refused.',
        `- To overwrite a file, prefer the \`write\` / \`edit\` tools. Use \`${TRASH_TOOL}\` only when a path must go away.`,
        `- \`${STATUS_TOOL}\` reports current bin occupancy if you need to confirm a deletion landed.`,
      ].join('\n'),
    });
  } catch (error) {
    // A host without the system-prompt service still gets the enforcement half.
    ctx.logger?.warn?.('delete-guard: systemPrompt section not registered:', error.message);
  }
}

/**
 * Format a byte count for display.
 * @param bytes - the count.
 * @returns a human-readable string.
 */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export { classifyCommand } from './guard.js';
