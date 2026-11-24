/**
 * Structural check for the three READMEs.
 *
 * `README.md` / `README.en.md` / `README.ja.md` are the same document in three
 * languages. Editing one and forgetting another does not show up in a diff — the
 * wording differs anyway — so the check is on structure: the same sections, the same
 * number of table rows, one H1.
 *
 * This exists because a previous README rewrite silently duplicated each file inside
 * itself (a `String.replace` replacement string contained `$`, which JavaScript
 * expanded). Counting H1s was what found it; the numbers below are what the fix has
 * to keep matching.
 *
 * Run: node scripts/verify-readme-structure.mjs
 * Exit code 1 when the three files disagree or a file has more than one H1.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['README.md', 'README.en.md', 'README.ja.md'];

/**
 * Measure the structural facts that must agree across the three files.
 *
 * Headings are counted **outside code fences only**: a Markdown block that shows a
 * shell command can contain `# comment` lines, and an early version of this script
 * reported five H1s because of them. Counting inside fences would flag every README
 * that documents a PowerShell snippet.
 *
 * @param text - the file's contents.
 * @returns the counts and the section headings, in order.
 */
function measure(text) {
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let h1 = 0;
  const h2 = [];
  let tableRows = 0;
  let codeFences = 0;

  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      codeFences += 1;
      continue;
    }
    if (inFence) continue;
    if (/^# /.test(line)) h1 += 1;
    const section = /^## (.+)$/.exec(line);
    if (section !== null) h2.push(section[1].trim());
    if (/^\| /.test(line)) tableRows += 1;
  }
  return { h1, h2Count: h2.length, h2, tableRows, codeFences };
}

const measured = FILES.map((name) => ({ name, ...measure(readFileSync(join(ROOT, name), 'utf8')) }));

let failed = false;
const base = measured[0];

for (const m of measured) {
  const problems = [];
  if (m.h1 !== 1) problems.push(`H1 count is ${m.h1}, expected 1`);
  if (m.h2Count !== base.h2Count) problems.push(`H2 count ${m.h2Count}, ${base.name} has ${base.h2Count}`);
  if (m.tableRows !== base.tableRows) problems.push(`table rows ${m.tableRows}, ${base.name} has ${base.tableRows}`);
  if (m.codeFences % 2 !== 0) problems.push(`odd number of code fences (${m.codeFences}) — an unclosed block`);

  const status = problems.length === 0 ? 'ok  ' : 'FAIL';
  if (problems.length > 0) failed = true;
  console.log(`${status} ${m.name.padEnd(14)} H1=${m.h1}  H2=${m.h2Count}  rows=${m.tableRows}  fences=${m.codeFences}`);
  for (const p of problems) console.log(`       ${p}`);
}

// Section titles differ by language, so only the position and count are comparable.
// Print them side by side anyway: a missing section is easier to spot by name.
const width = Math.max(...measured.map((m) => m.h2.length));
console.log('\nsections by position:');
for (let i = 0; i < width; i += 1) {
  const row = measured.map((m) => (m.h2[i] ?? '(none)').slice(0, 34).padEnd(36)).join('');
  console.log('  ' + row);
}

if (failed) {
  console.error('\nREADME structure differs between languages, or a file has a stray H1.');
  process.exit(1);
}
console.log('\nthree READMEs are structurally identical');
