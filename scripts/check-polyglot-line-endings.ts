/**
 * Validate the line-ending structure of the tracked .cmd files.
 *
 * Polyglot .cmd files (tools/node.cmd) mix line endings on purpose: CRLF for
 * the header up to `::CMDLITERAL` and for the batch part from `:CMDSCRIPT`, LF
 * for the bash body between them. cmd.exe misparses LF-only batch under DBCS
 * code pages (936/932/949). sh on Linux and macOS reads a CR in the body as
 * part of each command: `set -eu` fails and the wrapper does not run. A .cmd
 * without `::CMDLITERAL` is pure batch and must be CRLF throughout.
 *
 * `*.cmd -text` in .gitattributes keeps the bytes across checkouts but does
 * not enforce the structure: an editor save can turn the whole file into CRLF
 * or LF without a visible diff.
 *
 * Run:   node scripts/check-polyglot-line-endings.ts [--staged] [--fix]
 *   --staged  check the index instead of the working tree
 *   --fix     rewrite working-tree files with the expected structure
 * Exit 0 when every file matches, 1 with diagnostics otherwise.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TERMINATOR = '::CMDLITERAL';
const SCRIPT_LABEL = ':CMDSCRIPT';

type Ending = 'CRLF' | 'LF' | 'NONE';
interface Line {
  text: string;
  ending: Ending;
}

function splitLines(bytes: Buffer): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue;
    const hasCR = i > start && bytes[i - 1] === 0x0d;
    lines.push({ text: bytes.subarray(start, hasCR ? i - 1 : i).toString('utf8'), ending: hasCR ? 'CRLF' : 'LF' });
    start = i + 1;
  }
  if (start < bytes.length) lines.push({ text: bytes.subarray(start).toString('utf8'), ending: 'NONE' });
  return lines;
}

/** Expected ending per line, or an error when the polyglot markers are broken. */
function expectedEndings(lines: Line[]): ('CRLF' | 'LF')[] | string {
  const terminator = lines.findIndex((l, i) => i > 0 && l.text === TERMINATOR);
  if (terminator < 0) return lines.map(() => 'CRLF');
  const script = lines.findIndex((l) => l.text === SCRIPT_LABEL);
  if (script < 0) return `missing '${SCRIPT_LABEL}' label line`;
  if (script < terminator) {
    return `'${SCRIPT_LABEL}' at line ${script + 1} is before '${TERMINATOR}' at line ${terminator + 1}`;
  }
  return lines.map((_, i) => (i > terminator && i < script ? 'LF' : 'CRLF'));
}

export function checkBytes(name: string, bytes: Buffer): string[] {
  const lines = splitLines(bytes);
  const expected = expectedEndings(lines);
  if (typeof expected === 'string') return [`${name}: ${expected}`];
  const errors: string[] = [];
  lines.forEach((line, i) => {
    if (line.ending !== 'NONE' && line.ending !== expected[i]) {
      errors.push(`${name}:${i + 1}: expected ${expected[i]}, got ${line.ending}`);
    }
  });
  return errors;
}

/** The bytes with the expected endings, or null when the polyglot markers are broken. */
export function fixBytes(bytes: Buffer): Buffer | null {
  const lines = splitLines(bytes);
  const expected = expectedEndings(lines);
  if (typeof expected === 'string') return null;
  const out = lines.map((l, i) => l.text + (l.ending === 'NONE' ? '' : expected[i] === 'CRLF' ? '\r\n' : '\n'));
  return Buffer.from(out.join(''), 'utf8');
}

function git(...args: string[]): Buffer {
  return execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 16 * 1024 * 1024 });
}

export function trackedCmdFiles(): string[] {
  return git('ls-files', '-z', '--', '*.cmd').toString('utf8').split('\0').filter(Boolean);
}

export function checkAll(staged = false): string[] {
  return trackedCmdFiles().flatMap((f) => checkBytes(f, staged ? git('show', `:${f}`) : readFileSync(join(ROOT, f))));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.includes('--fix')) {
    for (const f of trackedCmdFiles()) {
      const abs = join(ROOT, f);
      const before = readFileSync(abs);
      const after = fixBytes(before);
      // Broken markers need a manual edit; the check below reports them.
      if (after && !after.equals(before)) {
        writeFileSync(abs, after);
        console.log(`fixed ${f}`);
      }
    }
  }
  const errors = checkAll(args.includes('--staged'));
  if (errors.length > 0) {
    console.error('Line-ending structure violations:');
    for (const e of errors) console.error(`  ${e}`);
    console.error('Fix: node scripts/check-polyglot-line-endings.ts --fix');
    process.exit(1);
  }
  console.log(`OK: ${trackedCmdFiles().length} .cmd files match the expected line-ending structure.`);
}
