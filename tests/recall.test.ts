import { describe, expect, it } from 'vitest';
import { RECALL_MAX_CHARS, runRecall } from '../src/recall/recall.js';
import type { Entry } from '../src/recall/transcript.js';

let n = 0;
const prompt = (text: string): Entry => ({ n: ++n, line: n, kind: 'prompt', text });
const reply = (text: string): Entry => ({ n: ++n, line: n, kind: 'reply', text });
const call = (id: string, tool: string, input: Record<string, unknown>, result?: string, extra: Partial<Entry> = {}): Entry =>
  ({ n: ++n, line: n, kind: 'call', id, tool, input, ...(result !== undefined && { result }), ...extra }) as Entry;

function session(): Entry[] {
  n = 0;
  return [
    prompt('The redis cache keeps timing out in staging.'),
    call('toolu_a', 'Bash', { command: 'kubectl logs redis-0' }, 'error: redis timeout after 5s\nretrying'),
    reply('The cache config sets a 5s timeout; raising it to 30s.'),
    call('toolu_b', 'Edit', { file_path: 'config/cache.yml', old_string: 'timeout: 5', new_string: 'timeout: 30' }, 'ok'),
    call('toolu_c', 'Bash', { command: 'npm test' }, 'PASS 42 tests'),
    prompt('Unrelated: what time is it?'),
    reply('It is noon.'),
  ];
}

describe('recall query', () => {
  it('ranks the entry holding the most of the words first, ignoring stopwords', () => {
    const out = runRecall(session(), { query: 'the redis timeout' });
    const order = [...out.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
    expect(order[0]).toBe(2);
    expect(order).not.toContain(7);
    expect(out).toContain('toolu_a');
  });

  it('pages five hits at a time and says how to get the next page', () => {
    n = 0;
    const many = Array.from({ length: 12 }, (_, i) => prompt(`deploy step ${i}`));
    const first = runRecall(many, { query: 'deploy' });
    expect([...first.matchAll(/^#\d+/gm)]).toHaveLength(5);
    expect(first).toMatch(/page 1\/3/);
    expect(first).toMatch(/page: 2/);
    expect([...runRecall(many, { query: 'deploy', page: 3 }).matchAll(/^#\d+/gm)]).toHaveLength(2);
  });

  it('treats a query with regex characters as a regex, and never runs a nested quantifier', () => {
    expect(runRecall(session(), { query: 'npm (test|run)' })).toMatch(/^#5/m);
    const started = Date.now();
    const out = runRecall([prompt(`${'a'.repeat(40)}!`)], { query: '(a+)+$' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out).toMatch(/no match/i);
  });

  it('shows where in a long input line the match is, and never lists recall calls', () => {
    n = 0;
    const entries = [
      call('t1', 'Edit', { file_path: 'a.ts', old_string: `${'x'.repeat(500)} NEEDLE here` }, 'ok'),
      call('t2', 'mcp__fast-jev-compaction__recall', { query: 'NEEDLE' }, 'earlier answer about NEEDLE'),
      call('t3', 'mcp__notes__recall', { query: 'NEEDLE' }, 'another server finds NEEDLE'),
    ];
    const out = runRecall(entries, { query: 'NEEDLE' });
    expect(out).toContain('NEEDLE here');
    expect(out).not.toContain('(t2)');
    expect(out).toContain('(t3)');
  });

  it('says so when nothing matches', () => {
    expect(runRecall(session(), { query: 'kubernetes ingress' })).toMatch(/no match/i);
  });
});

describe('recall expand', () => {
  it('returns a call in full, by tool_use_id or by #N', () => {
    for (const ref of ['toolu_b', '#4', '4']) {
      const out = runRecall(session(), { expand: [ref] });
      expect(out).toContain('#4 call Edit (toolu_b)');
      expect(out).toContain('"new_string": "timeout: 30"');
      expect(out).toContain('ok');
    }
  });

  it('reads an output Claude Code saved to a file instead of its preview', () => {
    n = 0;
    const entries = [call('toolu_s', 'Bash', { command: 'gh api' }, 'Output too large. Preview: abc', { savedTo: 'C:\\x\\abc.txt' } as Partial<Entry>)];
    const out = runRecall(entries, { expand: ['toolu_s'] }, { readFile: (path) => (path === 'C:\\x\\abc.txt' ? 'THE FULL OUTPUT' : undefined) });
    expect(out).toContain('THE FULL OUTPUT');
    expect(out).not.toContain('Preview: abc');
  });

  it('cuts at a line end within the budget and continues from an offset', () => {
    n = 0;
    const big = Array.from({ length: 4000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    const entries = [call('toolu_big', 'Read', { file_path: 'big.txt' }, big)];
    const first = runRecall(entries, { expand: ['toolu_big'] });
    expect(first.length).toBeLessThanOrEqual(RECALL_MAX_CHARS);
    const offset = Number(/offset: (\d+)/.exec(first)?.[1]);
    expect(offset).toBeGreaterThan(0);
    expect(big[offset - 1]).toBe('\n');
    const second = runRecall(entries, { expand: ['toolu_big'], offset });
    expect(second).toContain(big.slice(offset, offset + 40));
  });

  it('shares the budget between several entries', () => {
    n = 0;
    const big = 'y'.repeat(60_000);
    const entries = [call('t1', 'Read', {}, big), call('t2', 'Read', {}, big)];
    const out = runRecall(entries, { expand: ['t1', 't2'] });
    expect(out.length).toBeLessThanOrEqual(RECALL_MAX_CHARS);
    expect(out).toContain('#1 call Read (t1)');
    expect(out).toContain('#2 call Read (t2)');
  });

  it('names the references it could not find', () => {
    expect(runRecall(session(), { expand: ['toolu_zzz', '#99'] })).toMatch(/Not found: toolu_zzz, #99\./);
  });
});

describe('recall range', () => {
  it('lists entries in order, one short line each', () => {
    const out = runRecall(session(), { range: [2, 4] });
    expect([...out.matchAll(/^#(\d+)/gm)].map((m) => m[1])).toEqual(['2', '3', '4']);
    expect(out).toContain('Bash (toolu_a): kubectl logs redis-0');
  });
});

describe('recall request', () => {
  it('explains the modes when none is given', () => {
    expect(runRecall(session(), {})).toMatch(/query.*expand.*range/s);
  });
});
