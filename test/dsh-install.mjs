/**
 * Locate the `@deepseek-ai` module directory of an installed DSH.
 *
 * Two test layers import the *host's own* schema validators instead of trusting a
 * re-implementation, which is what caught the invalid schema in 1.0.2. That means
 * those layers need a DSH install on disk. The path used to be hard-coded to one
 * machine, which made `node test/run-all.mjs` unrunnable anywhere else — a public
 * repository cannot ship a test command that only works on the author's box.
 *
 * Resolution order:
 *   1. `DSH_NODE_MODULES` — an explicit path, for CI or an odd install layout.
 *   2. the npm global prefix on Windows (`%APPDATA%\npm`).
 *   3. `npm_config_prefix`, which pnpm/npm set when the test is run through a
 *      package script.
 *   4. a local `node_modules` under the working directory.
 *
 * @returns the directory that contains `dsh-tools`, or `undefined` when no
 *   installed DSH was found.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DSH_TAIL = join('node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');

const candidates = [
  process.env.DSH_NODE_MODULES,
  process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', DSH_TAIL),
  process.env.npm_config_prefix === undefined ? undefined : join(process.env.npm_config_prefix, DSH_TAIL),
  join(process.cwd(), 'node_modules', '@deepseek-ai'),
].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);

export function findDshModules() {
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'dsh-tools'))) return candidate;
  }
  return undefined;
}

/** The skip reason used by layers that need the host package. */
export const DSH_SKIP_REASON =
  'no installed DSH found: set DSH_NODE_MODULES to the directory containing @deepseek-ai/dsh-tools';
