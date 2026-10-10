import { describe, expect, it } from 'vitest';
import { PLUGIN_ID } from '../src/brand.js';
import { RECALL_MAX_CHARS, RECALL_TOOL, runRecall } from '../src/recall/recall.js';
import type { Entry } from '../src/recall/transcript.js';

it('spells the recall tool name from the plugin id', () => {
  expect(RECALL_TOOL).toBe(`mcp__${PLUGIN_ID}__recall`);
});

let n = 0;
const prompt = (text: string): Entry => ({ n: ++n, kind: 'prompt', text });
const reply = (text: string): Entry => ({ n: ++n, kind: 'reply', text });
const call = (id: string, tool: string, input: Record<string, unknown>, result?: string, extra: Partial<Entry> = {}): Entry =>
  ({ n: ++n, kind: 'call', id, tool, input, ...(result !== undefined && { result }), ...extra }) as Entry;

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

describe('recall labels', () => {
  it('names the subagent an entry came from, and the subagent an Agent call started', () => {
    n = 0;
    const entries = [
      call('t1', 'Agent', { description: 'Research recall' }, 'report', { agentId: 'a3d55' }),
      { ...call('t9', 'Bash', { command: 'rg BM25' }, 'hits'), where: 'general-purpose: Research recall' } as Entry,
    ];
    const out = runRecall(entries, { range: [1, 2] });
    expect(out).toContain('#1 call Agent (t1) [started agent a3d55]');
    expect(out).toContain('#2 [general-purpose: Research recall] call Bash (t9)');
  });
});

describe('recall touched', () => {
  function work(): Entry[] {
    n = 0;
    return [
      call('t1', 'Read', { file_path: 'src/app.ts' }, 'code'),
      call('t2', 'Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }, 'ok'),
      call('t3', 'Write', { file_path: 'docs/notes.md', content: 'x' }, 'ok'),
      call('t4', 'MultiEdit', { file_path: 'C:\\work\\src\\app.ts', edits: [] }, 'ok'),
      call('t5', 'NotebookEdit', { notebook_path: 'nb/analysis.ipynb', new_source: 'x' }, 'ok'),
      call('t6', 'Edit', { file_path: 'src/app.ts', old_string: 'b', new_string: 'c' }, 'Error: not found', { isError: true }),
      call('t7', 'Bash', { command: 'npm test' }, 'PASS'),
    ];
  }

  it('lists the files changed, newest first, with the calls that changed them', () => {
    expect(runRecall(work(), { touched: true })).toBe(
      [
        'Files changed in this session (4):',
        'src/app.ts: Edit #2 t2, Edit #6 t6 (failed)',
        'nb/analysis.ipynb: NotebookEdit #5 t5',
        'C:\\work\\src\\app.ts: MultiEdit #4 t4',
        'docs/notes.md: Write #3 t3',
        'For every call on a file, reads included: touched: "<part of the path>".',
      ].join('\n'),
    );
  });

  it('lists every call on the files a path part matches, reads included', () => {
    const out = runRecall(work(), { touched: 'app.ts' });
    expect(out.split('\n')).toEqual([
      'Calls on files matching "app.ts" (4):',
      '#1 Read src/app.ts (t1)',
      '#2 Edit src/app.ts (t2)',
      '#4 MultiEdit C:\\work\\src\\app.ts (t4)',
      '#6 Edit src/app.ts (t6, failed)',
      'Expand a call by its id for its input and result.',
    ]);
    expect(runRecall(work(), { touched: 'nothing.rs' })).toBe('No calls on files matching "nothing.rs".');
  });

  it('says so when nothing was changed', () => {
    n = 0;
    expect(runRecall([prompt('hi')], { touched: true })).toBe('No files changed in this session.');
  });
});

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

  it('treats a query with regex characters as a regex', () => {
    expect(runRecall(session(), { query: 'npm (test|run)' })).toMatch(/^#5/m);
  });

  it('shows where in a long input line the match is, and never lists recall calls', () => {
    n = 0;
    const entries = [
      call('t1', 'Edit', { file_path: 'a.ts', old_string: `${'x'.repeat(500)} NEEDLE here` }, 'ok'),
      call('t2', 'mcp__jetcompact__recall', { query: 'NEEDLE' }, 'earlier answer about NEEDLE'),
      call('t3', 'mcp__notes__recall', { query: 'NEEDLE' }, 'another server finds NEEDLE'),
    ];
    const out = runRecall(entries, { query: 'NEEDLE' });
    expect(out).toContain('NEEDLE here');
    expect(out).not.toContain('(t2)');
    expect(out).toContain('(t3)');
  });

  it('matches a regex that could backtrack without end as literal text', () => {
    n = 0;
    const entries = [prompt(`${'a'.repeat(28)}!`), prompt(`${'a'.repeat(40)}`)];
    for (const query of ['(a|a)*b', '(.*a){12}b', 'a*a*a*a*b', '(a+)+$', '(x)\\1+']) {
      const started = Date.now();
      runRecall(entries, { query });
      expect(Date.now() - started, query).toBeLessThan(500);
    }
  });

  it('falls back to keywords when a query that looks like a regex finds nothing', () => {
    expect(runRecall(session(), { query: 'redis$' })).toMatch(/^#2 call Bash/m);
  });

  it('keeps a long query out of the answer', () => {
    expect(runRecall(session(), { query: 'zzz '.repeat(2_000) }).length).toBeLessThan(400);
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

  it('never answers past the budget, however many entries are asked for', () => {
    n = 0;
    const input = { content: 'i'.repeat(3_000) };
    const many = Array.from({ length: 50 }, (_, i) => call(`t${i}`, 'Write', input, `${'r'.repeat(80)}\n`.repeat(600)));
    for (const count of [1, 5, 10, 11, 22, 50]) {
      const out = runRecall(many, { expand: many.slice(0, count).map((e) => (e.kind === 'call' ? e.id : '')) });
      expect(out.length, `${count} entries`).toBeLessThanOrEqual(RECALL_MAX_CHARS);
    }
    const capped = runRecall(many, { expand: many.slice(0, 12).map((e) => (e.kind === 'call' ? e.id : '')) });
    expect([...capped.matchAll(/^#\d+ call/gm)]).toHaveLength(10);
    expect(capped).toMatch(/Not shown, 10 per answer: t10, t11/);
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
