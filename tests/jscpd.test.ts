/**
 * The duplicate code gate: jscpd scans the repository with .jscpd.json and
 * fails on a clone whose fingerprint is not in .jscpd-baseline.json.
 *
 * The commands, the rules and the baseline refresh are in
 * docs/duplicate-code.md.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The pinned devDependency; a jscpd on PATH may be another version, whose
// fingerprints differ from the baseline's.
const JSCPD = createRequire(import.meta.url).resolve('jscpd/run-jscpd.js');

interface CloneFile {
  name: string;
  start: number;
  end: number;
}

const location = (f: CloneFile) => `${f.name.replace(/\\/g, '/')}:${f.start}-${f.end}`;

it('finds no clone that is missing from the baseline', () => {
  const out = mkdtempSync(join(tmpdir(), 'fjc-jscpd-'));
  try {
    const args = ['-c', '.jscpd.json', '--reporters', 'json', '--output', out, '--fail-on-new-clones', '--fail-on-empty'];
    const run = spawnSync(process.execPath, [JSCPD, ...args], { cwd: ROOT, encoding: 'utf8' });
    const output = `${run.stdout}${run.stderr}`;
    const file = join(out, 'jscpd-report.json');
    expect(existsSync(file), `jscpd wrote no report:\n${output}`).toBe(true);
    const report = JSON.parse(readFileSync(file, 'utf8'));

    // A config change that drops most of the tree would pass vacuously.
    expect(report.statistics.total.sources, 'the scan read too few files: check the path and ignore lists of .jscpd.json')
      .toBeGreaterThan(30);

    const fresh: string[] = report.duplicates
      .filter((d: { isNew?: boolean }) => d.isNew)
      .map((d: { firstFile: CloneFile; secondFile: CloneFile }) => `${location(d.firstFile)} ~ ${location(d.secondFile)}`);
    expect(fresh, 'new duplicate code. Extract the shared code instead of copying it. See docs/duplicate-code.md').toEqual([]);
    expect(run.status, `jscpd failed:\n${output}`).toBe(0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
