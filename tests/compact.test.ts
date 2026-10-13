import { describe, expect, it } from 'vitest';
import {
  algorithmicAnswers,
  applyDecisions,
  batchCalls,
  CompactionInterrupted,
  buildJevRequest,
  collectToolCalls,
  compact,
  compactMessages,
  decideCall,
  estimateTokens,
  fitState,
  JevClient,
  parseJevResponse,
  rankDecisions,
  reductionRatio,
  resolveOptions,
  sliceSurrogateSafe,
  truncate,
  type CallAnswer,
  type CallSize,
  type HistoryToolCall,
  type JevAsker,
  type JevQuestions,
  type Message,
  type ToolCall,
} from '../src/index.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

const fileA = 'export const a = 1;\n'.repeat(50);
const fileB = 'export const b = 2;\n'.repeat(50);

function transcript(): Message[] {
  return [
    message('user', 'Never edit anything under src/generated. Fix the failing test.'),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    message('assistant', 'a.ts looks fine; checking b.ts'),
    call('tool-2', 'Read', { file_path: 'src/b.ts' }, fileB),
    result('tool-2', fileB),
    call('tool-3', 'Bash', { command: 'npm test' }, 'FAIL b.test.ts'),
    result('tool-3', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'The failure is in b.test.ts; fixing now.'),
    message('user', 'go ahead'),
  ];
}

type Seen = { state: unknown; questions: string[] };

function fakeJev(answer: (name: string) => number, seen: Seen[] = []): JevAsker {
  return {
    async ask(state, questions: JevQuestions) {
      seen.push({ state, questions: Object.keys(questions) });
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: answer(key) }]),
        ),
      };
    },
  };
}

const fit = {
  maxStateTokens: 25_000,
  preserveRecentMessages: 0,
  goal: 'fix the test',
};

describe('options', () => {
  it('fills in defaults and ignores non-finite values', () => {
    expect(resolveOptions()).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      maxStateTokens: 25_000,
      maxRequestTokens: 30_000,
      truncateHeadChars: 300,
    });
    expect(resolveOptions({
      keepThreshold: Number.NaN,
      preserveRecentMessages: 2.7,
      truncateHeadChars: -1.2,
    })).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 2,
      truncateHeadChars: 0,
    });
  });
});

describe('token estimate', () => {
  it('charges words, digits and symbols separately and never undercounts JSON badly', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBe(2);
    expect(estimateTokens('internationalization')).toBe(4);
    expect(estimateTokens('12345678')).toBe(4);
    const json = JSON.stringify({ file_path: '/Users/x/src/a.ts', old_string: 'a = 1;', n: 42 });
    expect(estimateTokens(json)).toBeGreaterThanOrEqual(Math.ceil(json.length / 3));
  });

  it('charges dense runs (hex, UUIDs, base64) at least ~3 chars per token (#81)', () => {
    const blob = 'c3RhcnQgdGhlIGNvbXBhY3Rpb24gZnJvbSB0aGUgaG9vayBhbmQga2VlcCBpdCBydW5uaW5n';
    expect(estimateTokens(blob)).toBeGreaterThanOrEqual(Math.ceil(blob.length / 3));
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(estimateTokens(uuid)).toBeGreaterThanOrEqual(Math.ceil(uuid.replace(/-/g, '').length / 3));
    const sha = 'd41d8cd98f00b204e9800998ecf8427e';
    expect(estimateTokens(sha)).toBeGreaterThanOrEqual(Math.ceil(sha.length / 3));
    // prose and ordinary identifiers keep the word rate
    expect(estimateTokens('internationalization')).toBe(4);
    expect(estimateTokens('estimateTokens')).toBe(3);
    expect(estimateTokens('12345678')).toBe(4);
    expect(estimateTokens('utf8 base64')).toBeLessThan(6);
    // repeated filler compresses well and stays on the word rate
    expect(estimateTokens('x'.repeat(200))).toBe(34);
  });
});

describe('tool call collection', () => {
  it('pairs each tool call with its result and pins recent ones', () => {
    const calls = collectToolCalls(transcript(), 3);
    expect(calls.map((c) => [c.id, c.tool, c.callIndex, c.resultIndex, c.pinned])).toEqual([
      ['t1', 'Read', 1, 2, false],
      ['t2', 'Read', 4, 5, false],
      ['t3', 'Bash', 6, 7, true],
    ]);
    expect(calls[2]?.isError).toBe(true);
    expect(calls[0]?.resultChars).toBe(fileA.length);
  });

  it('ignores calls without a result', () => {
    expect(collectToolCalls([message('user', 'hi'), call('x', 'Read', {}, '')], 0)).toHaveLength(0);
  });
});

describe('state fitting', () => {
  it('sends the whole history with tool results replaced by a note', () => {
    const messages = transcript();
    const { state, stage } = fitState(messages, collectToolCalls(messages, 0), fit);
    expect(stage).toBe('full');
    const json = JSON.stringify(state);
    expect(json).not.toContain('export const a = 1;');
    expect(json).toContain('Never edit anything under src/generated');
    expect(json).toContain('go ahead');
    expect(state.history.map((entry) => entry.i)).toEqual([0, 1, 3, 4, 6, 8, 9]);
    expect(state.history[1]?.tool_calls?.[0]).toMatchObject({
      id: 't1',
      tool: 'Read',
      result: `ok, ${fileA.length} chars (omitted)`,
    });
    expect((state.history[4]?.tool_calls?.[0] as HistoryToolCall).result).toMatch(/^error, /);
  });

  it('defaults the goal to the latest user prompts', () => {
    const { state } = fitState(transcript(), [], { ...fit, goal: '' });
    expect(state.goal).toContain('Fix the failing test');
    expect(state.goal).toContain('go ahead');
  });

  it('truncates tool inputs before touching message text', () => {
    const messages = [
      message('user', 'start'),
      call('w', 'Write', { file_path: 'x.ts', content: 'x'.repeat(5000) }, 'ok'),
      result('w', 'ok'),
      message('assistant', 'written'),
    ];
    const { state, stage, tokens } = fitState(messages, collectToolCalls(messages, 0), {
      ...fit,
      maxStateTokens: 320,
    });
    expect(stage).toBe('inputs<=200');
    expect(tokens).toBeLessThanOrEqual(320);
    expect(state.history[0]?.text).toBe('start');
    expect((state.history[1]?.tool_calls?.[0] as HistoryToolCall).input.length).toBeLessThanOrEqual(200);
  });

  it('shrinks old tool calls to one line each when nothing else is left to cut', () => {
    const messages = [message('user', 'start')];
    for (let i = 0; i < 40; i += 1) {
      messages.push(call(`c${i}`, 'Read', { file_path: `/repo/src/module-${i}.ts` }, 'x'), result(`c${i}`, 'x'));
    }
    messages.push(message('assistant', 'done'));
    const calls = collectToolCalls(messages, 1);
    const full = fitState(messages, calls, { ...fit, preserveRecentMessages: 1 });
    const compacted = fitState(messages, calls, {
      ...fit,
      preserveRecentMessages: 1,
      maxStateTokens: Math.floor(full.tokens * 0.8),
    });
    expect(compacted.stage).toBe('old calls compacted');
    expect(compacted.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.8));
    expect(compacted.tokens).toBeGreaterThanOrEqual(estimateTokens(JSON.stringify(compacted.state)));
    expect(compacted.state.history[1]?.tool_calls?.[0]).toBe(
      't1 Read file_path=/repo/src/module-0.ts → ok 1ch',
    );
    expect(compacted.state.history.at(-1)?.text).toBe('done');

    const merged = fitState(messages, calls, {
      ...fit,
      preserveRecentMessages: 1,
      maxStateTokens: Math.floor(full.tokens * 0.45),
    });
    expect(merged.stage).toBe('old calls merged');
    expect(merged.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.45));
    expect(merged.state.history).toHaveLength(3);
    expect(merged.state.history[1]?.tool_calls).toHaveLength(40);
    expect(merged.state.history[1]?.tool_calls?.[39]).toMatch(/^t40 Read /);
    expect(merged.state.history[0]?.text).toBe('start');
    expect(merged.state.history[2]?.text).toBe('done');
  });

  it('abridges long texts oldest-first and collapses old messages last', () => {
    const long = (n: number) => `${n} ` + 'lorem ipsum '.repeat(300);
    const messages = [
      message('user', long(0)),
      message('assistant', long(1)),
      message('user', long(2)),
      message('assistant', long(3)),
      message('user', 'latest'),
    ];
    const abridged = fitState(messages, [], { ...fit, maxStateTokens: 1800, preserveRecentMessages: 1 });
    expect(abridged.stage).toBe('texts abridged');
    expect(abridged.tokens).toBeLessThanOrEqual(1800);
    expect(abridged.state.history[1]?.text).toContain('chars omitted');
    expect(abridged.state.history[0]?.text).toBe(long(0));
    expect(abridged.state.history[4]?.text).toBe('latest');

    const collapsed = fitState(messages, [], { ...fit, maxStateTokens: 420, preserveRecentMessages: 1 });
    expect(collapsed.stage).toBe('old messages collapsed');
    expect(collapsed.tokens).toBeLessThanOrEqual(420);
    expect(collapsed.state.history[1]?.text).toMatch(/^\[… \d+ chars omitted …\]$/);
    expect(collapsed.state.history[0]?.text).toContain('lorem');
    expect(collapsed.state.history[4]?.text).toBe('latest');
  });

  it('throws when the history cannot be fitted', () => {
    const messages = [message('user', 'a'.repeat(2000)), message('assistant', 'b')];
    expect(() => fitState(messages, [], { ...fit, maxStateTokens: 50 })).toThrow(/too large/);
  });
});

describe('question batching', () => {
  const calls: ToolCall[] = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i + 1}`,
    tool_use_id: `tool-${i + 1}`,
    tool: 'Read',
    input: {},
    callIndex: i * 2 + 1,
    resultIndex: i * 2 + 2,
    resultChars: 100,
    isError: false,
    pinned: false,
  }));
  const options = { maxRequestTokens: 30_000 };

  it('puts everything in one request when it fits', () => {
    expect(batchCalls(calls, 1000, options)).toHaveLength(1);
  });

  it('splits questions across requests when the state leaves little room', () => {
    const batches = batchCalls(calls, 29_600, options);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((c) => c.id)).toEqual(calls.map((c) => c.id));
  });

  it('throws when a single question does not fit', () => {
    expect(() => batchCalls(calls, 29_990, options)).toThrow(/no room/);
  });
});

describe('decisions', () => {
  const options = { keepThreshold: 0.5 };
  const unpinned = { id: 't1', tool: 'Read', pinned: false };

  it('keeps, drops the result, or drops the call based on the keep probabilities', () => {
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.7 }, options).action).toBe('keep');
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.2 }, options).action).toBe('drop_result');
    expect(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, options).action).toBe('drop_call');
    expect(decideCall({ ...unpinned, pinned: true }, { keepCall: 0, keepResult: 0 }, options)).toMatchObject({
      action: 'keep',
      reason: 'pinned',
    });
  });

  it('stubs instead of dropping the call when dropCalls is false', () => {
    const noDrop = { keepThreshold: 0.5, dropCalls: false };
    expect(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, noDrop)).toMatchObject({
      action: 'stub_call',
      reason: 'call_stubbed',
    });
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.2 }, noDrop).action).toBe('drop_result');
    expect(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, { ...noDrop, dropCalls: true }).action).toBe('drop_call');
  });

  it('a stubbed call keeps its tool name and truncates input and result', () => {
    const long = 'x'.repeat(2000);
    const messages: Message[] = [
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: long }, text: long }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: long }] },
      { role: 'assistant', text: 'done', toolUses: [] },
    ];
    const calls = collectToolCalls(messages, 0);
    const decisions = calls.map((call) => decideCall(call, { keepCall: 0.1, keepResult: 0.1 }, { keepThreshold: 0.5, dropCalls: false }));
    const out = applyDecisions(messages, decisions, calls, 100);
    expect(out).toHaveLength(4);
    const use = out[1]!.toolUses[0]!;
    expect(use.tool).toBe('Bash');
    expect(JSON.stringify(use.input).length).toBeLessThan(400);
    expect(String((use.input as { note?: string }).note)).toMatch(/truncated \d+ chars of this tool input/);
    expect(use.text).toMatch(/truncated \d+ chars of this tool result/);
    expect(out[2]!.toolResults![0]!.text).toMatch(/truncated \d+ chars of this tool result/);
  });

  it('removes dropped calls and truncates dropped results', () => {
    const messages = transcript();
    messages[4]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[5]!.toolResults![0]!.text = 'x'.repeat(2000);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, options),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.1 }, options),
      decideCall(calls[2]!, { keepCall: 0.9, keepResult: 0.9 }, options),
    ];
    const kept = applyDecisions(messages, decisions, calls, 300);

    expect(kept.map((m) => m.text || m.toolUses[0]?.tool_use_id || m.toolResults?.[0]?.tool_use_id)).toEqual([
      'Never edit anything under src/generated. Fix the failing test.',
      'a.ts looks fine; checking b.ts',
      'tool-2',
      'tool-2',
      'tool-3',
      'tool-3',
      'The failure is in b.test.ts; fixing now.',
      'go ahead',
    ]);
    expect(kept[0]).toBe(messages[0]);
    expect(kept[2]).not.toBe(messages[4]);
    expect(kept[2]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[jetcompact truncated 1700 chars`),
    );
    expect(kept[3]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[jetcompact truncated 1700 chars`),
    );
    expect(kept[2]).not.toBe(messages[4]);
    expect(kept[3]).not.toBe(messages[5]);
    expect(kept[4]).toBe(messages[6]);
    expect(kept[5]?.toolResults?.[0]?.text).toContain('expected 2 to be 3');

    const shortMessages = transcript();
    shortMessages[4]!.toolUses[0]!.text = 'y'.repeat(100);
    shortMessages[5]!.toolResults![0]!.text = 'y'.repeat(100);
    const shortKept = applyDecisions(shortMessages, decisions, calls, 300);
    expect(shortKept[2]).toBe(shortMessages[4]);
    expect(shortKept[3]).toBe(shortMessages[5]);
  });

  it('drops empty assistant messages but keeps thinking-only text', () => {
    const empty = message('assistant', '');
    const thinking = message('assistant', 'thinking through the next step');
    const messages = [message('user', 'start'), empty, thinking, message('user', 'done')];

    expect(applyDecisions(messages, [], [], 300)).toEqual([
      messages[0],
      thinking,
      messages[3],
    ]);
  });

  it('honours truncateHeadChars, including a zero head', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 })];
    const original = messages[2]!.toolResults![0]!.text;
    const total = original.length;

    const kept = applyDecisions(messages, decisions, calls, 50);
    expect(kept[2]?.toolResults?.[0]?.text).toBe(
      `${original.slice(0, 50)}\n[jetcompact truncated ${total - 50} chars of this tool result; re-run the tool if needed]`,
    );
    expect(kept[1]?.toolUses[0]?.text).toBe(kept[2]?.toolResults?.[0]?.text);

    const noHead = applyDecisions(messages, decisions, calls, 0);
    expect(noHead[2]?.toolResults?.[0]?.text).toBe(
      `[jetcompact truncated ${total} chars of this tool result; re-run the tool if needed]`,
    );
  });

  it('points a cut at the recall tool, by tool_use_id, when recall notes are on', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const id = messages[2]!.toolResults![0]!.tool_use_id;
    const stub = [decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, { keepThreshold: 0.5, dropCalls: false })];
    messages[1]!.toolUses[0]!.input = { file_path: 'x'.repeat(1000) };
    const kept = applyDecisions(messages, stub, collectToolCalls(messages, 0), 50, true);
    expect(kept[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`\\[jetcompact truncated \\d+ chars of this tool result; full text: recall expand \\["${id}"\\]\\]$`),
    );
    const inputChars = JSON.stringify(messages[1]!.toolUses[0]!.input).length;
    expect(kept[1]?.toolUses[0]?.input['note']).toBe(
      `[jetcompact truncated ${inputChars - 50} chars of this tool input; full text: recall expand ["${id}"]]`,
    );
  });

  it('opens the compacted history with one note on what was cut and how recall reads it back', async () => {
    const isNote = (m: Message) => m.text.startsWith('[jetcompact note]');
    // Threshold mode cuts every call Jev scores low; rank mode would keep this small transcript whole.
    const options = { ...fit, keepMode: 'threshold' as const, recallNotes: true };
    const first = await compact(transcript(), fakeJev(() => 0.01), options);
    expect(isNote(first.messages[0]!)).toBe(true);
    expect(first.messages[0]!.text).toMatch(/3 older tool calls reduced to stubs/);
    expect(first.messages[0]!.text).toMatch(/recall expand/);
    expect(first.messages[1]!.role).toBe('assistant');
    expect(first.messages[2]!.text).toBe(transcript()[0]!.text);
    // A later compaction replaces the note instead of stacking another.
    const again = await compact(first.messages, fakeJev(() => 0.01), options);
    expect(again.messages.filter(isNote)).toHaveLength(1);
    expect(isNote(again.messages[0]!)).toBe(true);
    expect(again.messages[2]!.text).toBe(transcript()[0]!.text);
    // Without recall there is nothing to point at; with nothing cut, nothing to say.
    expect((await compact(transcript(), fakeJev(() => 0.01), { ...options, recallNotes: false })).messages.some(isNote)).toBe(false);
    expect((await compact(transcript(), fakeJev(() => 0.99), options)).messages.some(isNote)).toBe(false);
  });

  it('names in the note the documents whose text was cut, so the model can read their instructions again', async () => {
    const doc = 'Always run the linter before a commit.\n'.repeat(40);
    const messages = [
      message('user', 'Follow docs/rules.md while you fix the bug.'),
      call('tool-1', 'Read', { file_path: 'docs\\rules.md' }, doc),
      result('tool-1', doc),
      call('tool-2', 'Read', { file_path: 'src/a.ts' }, fileA),
      result('tool-2', fileA),
      call('tool-3', 'Read', { file_path: 'NOTES.md' }, doc),
      result('tool-3', doc),
      message('assistant', 'Reading done.'),
    ];
    const options = { ...fit, keepMode: 'threshold' as const, recallNotes: true };
    // t3 (NOTES.md) stays whole; the rest is cut.
    const out = await compact(messages, fakeJev((key) => (key.endsWith('t3') ? 0.99 : 0.01)), options);
    const note = out.messages[0]!.text;
    expect(note).toMatch(/Documents read earlier whose text this compaction cut: `docs\/rules\.md`\. Read again/);
    expect(note).not.toContain('NOTES.md');
    expect(note).not.toContain('src/a.ts');
    // Nothing cut, nothing to name.
    expect((await compact(messages, fakeJev(() => 0.99), options)).messages[0]!.text).toBe(messages[0]!.text);
  });

  it('names the cut documents with the algorithmic decider too', async () => {
    const doc = 'Never push without asking.\n'.repeat(200);
    const messages: Message[] = [message('user', 'Read RULES.md, then fix the bug.'), call('tool-r', 'Read', { file_path: 'RULES.md' }, doc), result('tool-r', doc)];
    for (let n = 1; n <= 8; n += 1) messages.push(call(`tool-${n}`, 'Bash', { command: `npm test -- case${n}` }, 'ok'), result(`tool-${n}`, 'ok'));
    messages.push(message('assistant', 'All green.'));
    const out = await compact(messages, fakeJev(() => 0.99), { ...fit, keepMode: 'threshold', recallNotes: true, decider: 'algorithmic' });
    expect(out.messages[0]!.text).toMatch(/cut: `RULES\.md`\./);
  });

  it('names a document read in a turn the digest replaced', async () => {
    const doc = 'Use tabs.\n'.repeat(40);
    const messages: Message[] = [];
    for (let n = 1; n <= 6; n += 1) {
      messages.push(
        message('user', `step ${n}`),
        call(`tool-${n}`, 'Read', { file_path: n === 1 ? 'STYLE.md' : `src/f${n}.ts` }, doc),
        result(`tool-${n}`, doc),
        message('assistant', `done ${n}`),
      );
    }
    const options = { ...fit, keepMode: 'threshold' as const, recallNotes: true, oldProse: 'digest' as const, recentTurns: 2 };
    const out = await compact(messages, fakeJev(() => 0.99), options);
    expect(out.stats.oldProseReplaced).toBeGreaterThan(0);
    expect(out.messages[0]!.text).toMatch(/cut: `STYLE\.md`\./);
  });

  it('gives a cut recall answer the plain note: recall cannot expand its own calls', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.tool = 'mcp__jetcompact__recall';
    const calls = collectToolCalls(messages, 0);
    const cut = [decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 })];
    expect(applyDecisions(messages, cut, calls, 50, true)[2]?.toolResults?.[0]?.text).toMatch(/; re-run the tool if needed\]$/);
  });

  it('never cuts the head of a dropped result inside a surrogate pair', () => {
    const emoji = '\u{1F600}';
    const note = (omitted: number): string =>
      `[jetcompact truncated ${omitted} chars of this tool result; re-run the tool if needed]`;
    const truncated = (text: string): string | undefined => {
      const messages = transcript();
      messages[1]!.toolUses[0]!.text = text;
      messages[2]!.toolResults![0]!.text = text;
      const calls = collectToolCalls(messages, 0);
      const decisions = [decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 })];
      const kept = applyDecisions(messages, decisions, calls, 300);
      expect(kept[1]?.toolUses[0]?.text).toBe(kept[2]?.toolResults?.[0]?.text);
      return kept[2]?.toolResults?.[0]?.text;
    };

    const straddling = `${'x'.repeat(299)}${emoji.repeat(200)}`;
    expect(truncated(straddling)).toBe(`${'x'.repeat(299)}\n${note(straddling.length - 299)}`);

    const aligned = `${'x'.repeat(298)}${emoji.repeat(200)}`;
    expect(truncated(aligned)).toBe(`${'x'.repeat(298)}${emoji}\n${note(aligned.length - 300)}`);
  });

  it("never cuts the head of a stubbed call's input inside a surrogate pair", () => {
    const messages = transcript();
    // {"command":" is 12 characters, so the emoji sits at 299-300 of the JSON.
    messages[1]!.toolUses[0]!.input = { command: `${'x'.repeat(287)}${'\u{1F600}'.repeat(100)}` };
    const calls = collectToolCalls(messages, 0);
    const decisions = [decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, { keepThreshold: 0.5, dropCalls: false })];
    expect(decisions[0]!.action).toBe('stub_call');
    const head = String(applyDecisions(messages, decisions, calls, 300)[1]?.toolUses[0]?.input['input_head']);
    expect(head).toBe(`{"command":"${'x'.repeat(287)}`);
  });
});

describe('rank decisions', () => {
  const pool: ToolCall[] = ['t1', 't2', 't3', 't4'].map((id, i) => ({
    id,
    tool_use_id: `u${i}`,
    tool: 'Read',
    input: {},
    callIndex: i * 2,
    resultIndex: i * 2 + 1,
    resultChars: 100,
    isError: false,
    pinned: false,
  }));
  const sizes = new Map<string, CallSize>(
    pool.map((c) => [c.id, { resultTokens: 100, truncatedTokens: 10 }]),
  );
  const answers = (scores: Record<string, [number, number]>) =>
    new Map<string, CallAnswer>(
      Object.entries(scores).map(([id, [keepCall, keepResult]]) => [id, { keepCall, keepResult }]),
    );
  const actions = (scores: Record<string, [number, number]>, budgets: [number, number], calls = pool) =>
    rankDecisions(calls, answers(scores), sizes, {
      keepResultTokens: budgets[0],
      keepCallTokens: budgets[1],
    }).map((d) => d.action);

  it('keeps the best-scored results within budget even when every score is under 0.5', () => {
    const scores = { t1: [0.1, 0.12], t2: [0.2, 0.3], t3: [0.15, 0.2], t4: [0.3, 0.1] } as const;
    const out = rankDecisions(pool, answers(scores), sizes, { keepResultTokens: 200, keepCallTokens: 10 });
    expect(out.map((d) => [d.action, d.reason])).toEqual([
      ['drop_call', 'call_dropped'],
      ['keep', 'kept'],
      ['keep', 'kept'],
      ['drop_result', 'result_dropped'],
    ]);
  });

  it('drops every call when both budgets are 0', () => {
    const scores = { t1: [0.9, 0.9], t2: [0.9, 0.9], t3: [0.9, 0.9], t4: [0.9, 0.9] } as const;
    expect(actions(scores, [0, 0])).toEqual(['drop_call', 'drop_call', 'drop_call', 'drop_call']);
  });

  it('prefers the more recent call on equal scores', () => {
    const scores = { t1: [0.2, 0.2], t2: [0.2, 0.2], t3: [0.2, 0.2], t4: [0.2, 0.2] } as const;
    expect(actions(scores, [200, 0])).toEqual(['drop_call', 'drop_call', 'keep', 'keep']);
    expect(actions(scores, [0, 20])).toEqual(['drop_call', 'drop_call', 'drop_result', 'drop_result']);
  });

  it('skips a call too big for the remaining budget and never ranks pinned ones', () => {
    const big = new Map(sizes).set('t2', { resultTokens: 500, truncatedTokens: 10 });
    const calls = [pool[0]!, pool[1]!, { ...pool[2]!, pinned: true }];
    const out = rankDecisions(
      calls,
      answers({ t1: [0.1, 0.1], t2: [0.9, 0.9], t3: [0.9, 0.9] }),
      big,
      { keepResultTokens: 150, keepCallTokens: 0 },
    );
    expect(out.map((d) => [d.action, d.reason])).toEqual([
      ['keep', 'kept'],
      ['drop_call', 'call_dropped'],
      ['keep', 'pinned'],
    ]);
  });

  it('stubs non-kept calls by default and drops them with dropCalls', () => {
    const big = new Map([
      ['t1', { resultTokens: 100, truncatedTokens: 100 }],
      ['t2', { resultTokens: 100, truncatedTokens: 100 }],
    ]);
    const calls = [
      { id: 't1', tool: 'Read', pinned: false },
      { id: 't2', tool: 'Bash', pinned: true },
    ] as Parameters<typeof rankDecisions>[0];
    const ans = new Map([['t1', { keepCall: 0.1, keepResult: 0.1 }]]);
    const budgets = { keepResultTokens: 0, keepCallTokens: 0 };
    expect(rankDecisions(calls, ans, big, { ...budgets, dropCalls: false })[0]!.action).toBe('stub_call');
    expect(rankDecisions(calls, ans, big, { ...budgets, dropCalls: true })[0]!.action).toBe('drop_call');
  });

  it('is the default mode, with threshold mode still available', async () => {
    expect(resolveOptions().keepMode).toBe('rank');
    expect(resolveOptions({ keepMode: 'threshold' }).keepMode).toBe('threshold');
    expect(resolveOptions({ keepResultTokens: -5, keepCallTokens: Number.NaN })).toMatchObject({
      keepResultTokens: 0,
      keepCallTokens: 2_000,
    });
    const output = await compact(transcript(), fakeJev(() => 0.2), { preserveRecentMessages: 1 });
    expect(output.stats.kept + output.stats.resultsDropped).toBeGreaterThan(0);
    const threshold = await compact(transcript(), fakeJev(() => 0.2), {
      keepMode: 'threshold',
      dropCalls: true,
      preserveRecentMessages: 1,
    });
    expect(threshold.stats.callsDropped).toBe(threshold.stats.calls - threshold.stats.pinned);
  });
});

describe('compact', () => {
  it('resends the full state with every batch and merges the answers', async () => {
    const seen: Seen[] = [];
    const messages = transcript();
    const stateTokens = fitState(messages, collectToolCalls(messages, 1), {
      ...fit,
      goal: '',
      preserveRecentMessages: 1,
    }).tokens;
    const output = await compact(
      messages,
      fakeJev((name) => (name.startsWith('call_') ? 0.9 : 0.1), seen),
      { keepMode: 'threshold', preserveRecentMessages: 1, maxRequestTokens: stateTokens + 150 },
    );

    expect(output.stats.requests).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.flatMap((r) => r.questions).sort()).toEqual([
      'call_t1',
      'call_t2',
      'call_t3',
      'result_t1',
      'result_t2',
      'result_t3',
    ]);
    expect(new Set(seen.map((r) => JSON.stringify(r.state))).size).toBe(1);
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_result', 'drop_result', 'drop_result']);
    expect(output.messages).toHaveLength(messages.length);
    expect(output.stats).toMatchObject({ resultsDropped: 3, kept: 0, callsDropped: 0, pinned: 0 });
    expect(reductionRatio(output)).toBeGreaterThan(0);
  });

  it('ages results an earlier compaction cut: their head goes, their note stays', async () => {
    const messages = transcript();
    const cutBefore = `${'h'.repeat(300)}\n[jetcompact truncated 900 chars of this tool result; full text: recall expand ["tool-1"]]`;
    messages[2]!.toolResults![0]!.text = cutBefore;
    messages[1]!.toolUses[0]!.text = cutBefore;
    const keepAll = fakeJev(() => 0.9);
    const plain = await compact(messages, keepAll, { keepMode: 'threshold', preserveRecentMessages: 1 });
    expect(plain.messages[2]!.toolResults![0]!.text).toBe(cutBefore);
    expect(plain.stats.resultsAged).toBe(0);

    const aged = await compact(messages, keepAll, { keepMode: 'threshold', preserveRecentMessages: 1, ageCutResults: true });
    const note = '[jetcompact truncated 1200 chars of this tool result; full text: recall expand ["tool-1"]]';
    expect(aged.messages[2]!.toolResults![0]!.text).toBe(note);
    expect(aged.messages[1]!.toolUses[0]!.text).toBe(note);
    expect(aged.stats.resultsAged).toBe(1);
    // Output that only ends with a note naming another call is not a cut; nor is a pinned result.
    const quoted = transcript();
    quoted[2]!.toolResults![0]!.text = cutBefore.replace('["tool-1"]', '["other"]');
    const notCut = await compact(quoted, keepAll, { keepMode: 'threshold', preserveRecentMessages: 1, ageCutResults: true });
    expect(notCut.stats.resultsAged).toBe(0);
    const pinned = await compact(messages, keepAll, { keepMode: 'threshold', preserveRecentMessages: 99, ageCutResults: true });
    expect(pinned.stats.resultsAged).toBe(0);
    // A result cut by this compaction keeps its head until the next one.
    const fresh = await compact(transcript(), fakeJev(() => 0.1), { keepMode: 'threshold', preserveRecentMessages: 1, ageCutResults: true });
    expect(fresh.stats.resultsAged).toBe(0);
    expect(fresh.messages[2]!.toolResults![0]!.text).toMatch(/^[^[]+\n\[jetcompact truncated/);
  });

  it('decides without asking anyone under decider: algorithmic', async () => {
    const never: JevAsker = {
      async ask() {
        throw new Error('the algorithmic decider asks no model');
      },
    };
    const out = await compact(transcript(), never, { keepMode: 'threshold', preserveRecentMessages: 1, decider: 'algorithmic' });
    expect(out.stats.requests).toBe(0);
    // The oldest read is stubbed; the newer read and the error stay whole.
    expect(out.decisions.map((d) => d.action)).toEqual(['stub_call', 'keep', 'keep']);
    const scores = algorithmicAnswers(collectToolCalls(transcript(), 1).filter((c) => !c.pinned));
    expect(scores.get('t1')!.keepResult).toBeLessThan(scores.get('t2')!.keepResult);
    expect(scores.get('t3')!.keepResult).toBeGreaterThanOrEqual(0.9);
  });

  it('scores superseded, resolved and search output low in the algorithmic decider', () => {
    let at = 0;
    const tc = (tool: string, input: Record<string, unknown>, more: Partial<ToolCall> = {}): ToolCall => {
      at += 2;
      return { id: `t${at / 2}`, tool_use_id: `u${at}`, tool, input, callIndex: at, resultIndex: at + 1, resultChars: 500, isError: false, pinned: false, ...more };
    };
    const calls = [
      tc('Read', { file_path: 'C:\\app\\a.ts' }), // t1: a later Edit changed it
      tc('Read', { file_path: 'c:/app/b.ts' }), // t2: read again later
      tc('Read', { file_path: 'c:/app/d.ts', offset: 900 }, { isError: true }), // t3: fixed by t7
      tc('Bash', { command: 'make' }, { isError: true }), // t4: still failing
      tc('Grep', { pattern: 'x' }), // t5: search output
      tc('Bash', { command: 'git commit -m x' }), // t6: changes state
      tc('Read', { file_path: 'c:/app/d.ts' }), // t7
      tc('Edit', { file_path: 'c:/app/a.ts', old_string: 'a', new_string: 'b' }), // t8
      tc('Read', { file_path: 'C:/app/b.ts' }), // t9
      tc('WebFetch', { url: 'https://a.example' }, { isError: true }), // t10: no path; t11 does not fix it
      tc('WebFetch', { url: 'https://b.example' }), // t11
      tc('Read', { file_path: 'c:/app/c.ts' }), // t12: control, newest of its kind
    ];
    const s = algorithmicAnswers(calls);
    expect(s.get('t1')!.keepResult).toBeLessThanOrEqual(0.05);
    expect(s.get('t2')!.keepResult).toBeLessThanOrEqual(0.05);
    expect(s.get('t3')!.keepResult).toBeLessThanOrEqual(0.1);
    expect(s.get('t4')!.keepResult).toBeGreaterThanOrEqual(0.9);
    expect(s.get('t5')!.keepResult).toBeLessThan(0.3);
    expect(s.get('t6')!.keepCall).toBeGreaterThanOrEqual(0.9);
    expect(s.get('t9')!.keepResult).toBeGreaterThan(0.6);
    expect(s.get('t10')!.keepResult).toBeGreaterThanOrEqual(0.9);
    expect(s.get('t12')!.keepResult).toBeGreaterThan(0.8);
  });

  it('starts nothing once the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let summarized = 0;
    const summarize = async () => (summarized++, 'SUMMARY');
    await expect(
      compact(transcript(), fakeJev(() => 0.1), { oldProse: 'summarize', decider: 'algorithmic' }, { summarize, signal: controller.signal }),
    ).rejects.toBeInstanceOf(CompactionInterrupted);
    expect(summarized).toBe(0);
  });

  it('asks with true/false criteria only under questionCriteria', async () => {
    const asked: JevQuestions[] = [];
    const recorder: JevAsker = {
      async ask(_state, questions) {
        asked.push(questions);
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, noul: 0.9 }])) };
      },
    };
    await compact(transcript(), recorder, { preserveRecentMessages: 1 });
    await compact(transcript(), recorder, { preserveRecentMessages: 1, questionCriteria: true });
    const [plain, withCriteria] = [asked[0]!, asked.at(-1)!];
    expect(Object.values(plain).every((q) => q.type === 'noul' && q.criteria === undefined)).toBe(true);
    expect(Object.values(withCriteria).every((q) => q.type === 'noul' && q.criteria?.true && q.criteria.false)).toBe(true);
  });

  it('keeps everything without calling Jev when no tool call is a candidate', async () => {
    const seen: Seen[] = [];
    const messages = [message('user', 'hello'), message('assistant', 'hi')];
    const output = await compact(messages, fakeJev(() => 0, seen));
    expect(seen).toHaveLength(0);
    expect(output.stats).toMatchObject({ requests: 0, stateStage: '', calls: 0 });
    expect(output.messages).toEqual(messages);
  });

  it('reports a tiny reduction when Jev wants everything kept', async () => {
    const output = await compact(transcript(), fakeJev(() => 0.95), { preserveRecentMessages: 1 });
    expect(output.decisions.every((d) => d.action === 'keep')).toBe(true);
    expect(reductionRatio(output)).toBe(0);
  });

  it('rejects malformed answers', async () => {
    const broken: JevAsker = {
      ask: async () => ({ answers: { call_t1: { noul: 0.5 } } }),
    };
    await expect(compact(transcript(), broken, { preserveRecentMessages: 1 })).rejects.toThrow(
      /Invalid Jev answer/,
    );
  });
});

describe('HTTP client', () => {
  it('builds a System One request', () => {
    const request = buildJevRequest({ apiKey: 'k' }, { a: 1 }, {
      q: { type: 'noul', instructions: 'x' },
    });
    expect(request.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(request.headers.authorization).toBe('Bearer k');
    expect(JSON.parse(request.body)).toEqual({
      model: 'jev-latest',
      state: { a: 1 },
      questions: { q: { type: 'noul', instructions: 'x' } },
    });
  });

  it('rejects failed and malformed responses', () => {
    expect(() => parseJevResponse(500, false, 'boom')).toThrow(/500/);
    expect(() => parseJevResponse(200, true, 'not json')).toThrow(/malformed/);
    expect(() => parseJevResponse(200, true, '{}')).toThrow(/missing answers/);
    expect(parseJevResponse(200, true, '{"answers":{}}')).toEqual({ answers: {} });
  });

  it('asks over fetch and refuses to run without a key', async () => {
    const bodies: string[] = [];
    const client = new JevClient({
      apiKey: 'k',
      model: 'jev-test',
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ answers: { q: { noul: 0.4 } } }), { status: 200 });
      }) as typeof fetch,
    });
    const response = await client.ask('state', { q: { type: 'noul', instructions: 'x' } });
    expect(response.answers.q).toEqual({ noul: 0.4 });
    expect(JSON.parse(bodies[0]!).model).toBe('jev-test');

    const keyless = new JevClient({ apiKey: '' });
    await expect(keyless.ask('s', {})).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactMessages(transcript(), { apiKey: '', preserveRecentMessages: 1 }),
    ).rejects.toThrow(/TYPESAFE_API_KEY/);
  });
});

describe('windowed states when the history does not fit', () => {
  function long(n: number): Message[] {
    const out: Message[] = [message('user', 'Fix the failing build; never touch src/generated.')];
    for (let i = 0; i < n; i++) {
      out.push(message('assistant', `Step ${i}: ${'checking the next module and its callers '.repeat(6)}`));
      out.push(call(`w${i}`, 'Bash', { command: `npm test -- module${i}` }, ''));
      out.push(result(`w${i}`, `module${i}: 3 passed, 1 failed (exit code 1)\n${'x'.repeat(400)}`));
    }
    out.push(message('user', 'go on'));
    return out;
  }
  const options = { maxStateTokens: 3_000, maxRequestTokens: 6_000, preserveRecentMessages: 2 };

  it('splits into windows that each fit, and every candidate is asked', async () => {
    const messages = long(400);
    const calls = collectToolCalls(messages, 2);
    expect(() => fitState(messages, calls, resolveOptions(options))).toThrow(/history too large/);
    const seen: Seen[] = [];
    const out = await compact(messages, fakeJev(() => 0.1, seen), options);
    expect(out.stats.stateStage).toMatch(/^windows:\d+$/);
    expect(out.stats.stateTokens).toBeLessThanOrEqual(options.maxStateTokens);
    const asked = new Set(seen.flatMap((s) => s.questions).filter((q) => q.startsWith('call_')));
    expect(asked.size).toBe(calls.filter((c) => !c.pinned).length);
    expect(out.stats.requests).toBe(seen.length);
  });

  it('keeps a call that no window can fit, instead of throwing', async () => {
    const messages = long(5);
    const seen: Seen[] = [];
    const out = await compact(messages, fakeJev(() => 0.1, seen), { ...options, maxStateTokens: 200, goal: 'g'.repeat(5_000) });
    expect(seen.length).toBe(0);
    expect(out.stats.stateStage).toMatch(/unasked:\d+/);
    expect(out.decisions.every((d) => d.action === 'keep')).toBe(true);
    expect(out.messages).toEqual(messages);
  });
});

describe('surrogate-safe cuts (#128)', () => {
  // A lone surrogate: a high surrogate not followed by a low one, or a low
  // surrogate not preceded by a high one (the check from the issue report).
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('truncate steps the head cut back instead of orphaning a high surrogate', () => {
    // '🔥' is U+1F525 = D83D DE25; a UTF-16 cut at index 2 would split it.
    const out = truncate('a🔥b', 3);
    expect(out).toBe('a…');
    expect(lone.test(out)).toBe(false);
  });

  it('truncate leaves text alone when no cut is needed', () => {
    expect(truncate('a🔥b', 4)).toBe('a🔥b');
  });

  it('sliceSurrogateSafe drops the pair on head cuts instead of orphaning it', () => {
    const text = `${'x'.repeat(399)}🔥`;
    const head = sliceSurrogateSafe(text, 0, 400);
    expect(head).toBe('x'.repeat(399));
    expect(lone.test(head)).toBe(false);
  });

  it('sliceSurrogateSafe keeps the pair whole on tail cuts', () => {
    // A 150-char tail of this string would start on the low surrogate of 🔥.
    const text = `${'x'.repeat(149)}🔥${'x'.repeat(149)}`;
    const tail = sliceSurrogateSafe(text, text.length - 150, text.length);
    expect(tail).toBe(`🔥${'x'.repeat(149)}`);
    expect(lone.test(tail)).toBe(false);
  });

  it('abridged states serialise with no lone surrogates', () => {
    // The head cut at 400 would split the first 🔥; the 150-char tail would
    // start on the low surrogate of the second one.
    const text = `${'x'.repeat(399)}🔥${'y'.repeat(449)}🔥${'y'.repeat(149)}`;
    const fitted = fitState([message('user', text)], [], {
      maxStateTokens: 300,
      preserveRecentMessages: 1,
      goal: 'g',
    });
    expect(fitted.stage).toBe('texts abridged');
    const entry = fitted.state.history[0]?.text ?? '';
    expect(entry).toContain('chars omitted');
    expect(lone.test(JSON.stringify(fitted.state))).toBe(false);
  });

  it('buildJevRequest replaces lone-surrogate escapes instead of sending them', () => {
    const request = buildJevRequest({ apiKey: 'k' }, { evil: '\uD83D' } as never, {
      q: { type: 'noul', instructions: 'x' },
    });
    // The lone surrogate must not reach the wire as \ud83d (the API 400s on it).
    expect(request.body).not.toMatch(/\\ud83d(?!\\ud[c-f][0-9a-f]{2})/i);
    expect(request.body).toContain('\\ufffd');
    // A well-formed pair still round-trips untouched.
    const paired = buildJevRequest({ apiKey: 'k' }, { ok: '🔥' } as never, {
      q: { type: 'noul', instructions: 'x' },
    });
    expect(JSON.parse(paired.body).state).toEqual({ ok: '🔥' });
  });
});
