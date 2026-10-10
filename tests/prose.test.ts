import { describe, expect, it } from 'vitest';

import {
  buildDigest,
  collectReferences,
  compact,
  condenseOldProse,
  parseCondensed,
  splitOldProse,
  type JevAsker,
  type Message,
  type ProseSummarizer,
} from '../src/index.js';

const msg = (role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({
  role,
  text,
  toolUses: [],
  ...extra,
});

/** One turn: prompt, a tool call with its result, narration, final reply. */
function turn(n: number, extra = ''): Message[] {
  const id = `tool-${n}`;
  return [
    msg('user', `prompt ${n} ${extra}`),
    msg('assistant', `narration ${n}`, {
      toolUses: [{ tool_use_id: id, tool: 'Read', input: { file_path: `src/file${n}.ts` } }],
    }),
    msg('user', '', { toolResults: [{ tool_use_id: id, text: `contents ${n} `.repeat(200) }] }),
    msg('assistant', `final reply ${n}`),
  ];
}

const history = (turns: number): Message[] =>
  Array.from({ length: turns }, (_, i) => turn(i + 1)).flat();

function orphans(messages: readonly Message[]): string[] {
  const uses = new Set(messages.flatMap((m) => m.toolUses.map((u) => u.tool_use_id)));
  return messages.flatMap((m) =>
    (m.toolResults ?? []).map((r) => r.tool_use_id).filter((id) => !uses.has(id)),
  );
}

describe('splitOldProse', () => {
  it('cuts at the start of the recentTurns-th last user turn', () => {
    const messages = history(12);
    const split = splitOldProse(messages, 8)!;
    expect(split.old).toHaveLength(4 * 4);
    expect(split.recent[0]!.text).toBe('prompt 5 ');
    expect(split.recent).toHaveLength(8 * 4);
  });

  it('returns undefined when there are not more than recentTurns turns', () => {
    expect(splitOldProse(history(8), 8)).toBeUndefined();
    expect(splitOldProse(history(3), 8)).toBeUndefined();
  });

  it('does not count tool results or host notices as turns', () => {
    const messages = [
      ...history(3),
      msg('user', '<task-notification>done</task-notification>'),
      ...turn(4),
    ];
    const split = splitOldProse(messages, 2)!;
    expect(split.recent[0]!.text).toBe('prompt 3 ');
    expect(split.old.at(-1)!.text).toBe('final reply 2');
  });

  it('never separates a tool_use from its tool_result', () => {
    for (let recent = 1; recent < 6; recent++) {
      const split = splitOldProse(history(7), recent)!;
      expect(orphans(split.old)).toEqual([]);
      expect(orphans(split.recent)).toEqual([]);
    }
  });

  it('moves the cut back a turn when a result points across it', () => {
    const messages = history(4);
    // turn 3's result answers turn 2's call
    messages[10] = msg('user', '', { toolResults: [{ tool_use_id: 'tool-2', text: 'late' }] });
    const split = splitOldProse(messages, 2)!;
    expect(split.recent[0]!.text).toBe('prompt 2 ');
    expect(orphans(split.recent)).toEqual([]);
    expect(orphans(split.old)).toEqual([]);
  });
});

describe('digest', () => {
  it('keeps prompts and final replies, drops narration and results, lists tools and references', () => {
    const digest = buildDigest(history(3).concat(msg('user', 'see D-1234 and #4567 in src/a/b.ts')));
    expect(digest).toContain('• first prompt: prompt 1');
    expect(digest).toContain('assistant: final reply 2');
    expect(digest).toContain('tools: Read');
    expect(digest).not.toContain('narration 2');
    expect(digest).not.toContain('contents');
    expect(digest).toContain('src/file2.ts');
    expect(digest).toContain('D-1234');
    expect(digest).toContain('#4567');
  });

  it('collects references once, most frequent first', () => {
    const refs = collectReferences('src/a.ts src/b.ts src/b.ts https://x.dev/p. deadbeef1 abc');
    expect(refs[0]).toBe('src/b.ts');
    expect(refs).toContain('https://x.dev/p');
    expect(refs).toContain('deadbeef1');
    expect(refs).not.toContain('abc');
  });

  it('names the recall tool in its header when recall is on, and still reads as a digest', () => {
    const recalled = buildDigest(history(3), { recall: true });
    expect(recalled.split('\n')[0]).toMatch(/; the recall tool reads them back from the transcript \(query, expand\)\]$/);
    expect(parseCondensed(msg('user', recalled))?.kind).toBe('digest');
    expect(buildDigest(history(3)).split('\n')[0]).not.toMatch(/recall/);
  });

  it('truncates long prompts and replies', () => {
    const digest = buildDigest([msg('user', 'first'), msg('user', 'x'.repeat(5000)), msg('assistant', 'y'.repeat(5000))]);
    expect(digest.length).toBeLessThan(2500);
  });

  it('stays under its ceiling by dropping the oldest entries after the first prompt', () => {
    const digest = buildDigest(history(200), { maxChars: 3000 });
    expect(digest.length).toBeLessThanOrEqual(3000);
    expect(digest).toContain('• first prompt: prompt 1');
    expect(digest).toContain('prompt 200');
    expect(digest).toMatch(/\(\d+ older turns omitted\)/);
  });
});

describe('condenseOldProse', () => {
  const options = { oldProse: 'digest', recentTurns: 4 } as const;

  it('keeps mode and short histories untouched', async () => {
    const messages = history(10);
    const kept = await condenseOldProse(messages, { oldProse: 'keep', recentTurns: 4 });
    expect(kept.messages).toEqual(messages);
    expect(kept.applied).toBe('keep');
    expect((await condenseOldProse(history(4), options)).messages).toHaveLength(16);
  });

  it('replaces the prefix with a digest and an ack, leaves the recent suffix as the same objects', async () => {
    const messages = history(10);
    const out = await condenseOldProse(messages, options);
    expect(out.applied).toBe('digest');
    expect(out.messages).toHaveLength(2 + 4 * 4);
    expect(out.messages[0]!.role).toBe('user');
    expect(out.messages[1]!.role).toBe('assistant');
    expect(out.messages.slice(2)).toEqual(messages.slice(24));
    out.messages.slice(2).forEach((m, i) => expect(m).toBe(messages[24 + i]));
    expect(orphans(out.messages)).toEqual([]);
    expect(out.charsAfter).toBeLessThan(out.charsBefore);
  });

  it('folds a previous digest instead of chaining digests', async () => {
    const first = await condenseOldProse(history(10), options);
    const grown = [...first.messages, ...turn(11), ...turn(12), ...turn(13)];
    const second = await condenseOldProse(grown, options);
    const digests = second.messages.filter((m) => parseCondensed(m));
    expect(digests).toHaveLength(1);
    const marker = parseCondensed(digests[0]!)!;
    expect(marker.turns).toBe(9);
    expect(marker.body).toContain('• first prompt: prompt 1');
    expect(marker.body).toContain('prompt 9');
    expect(marker.body).not.toContain('prompt 10 ');
    expect(second.messages[0]).toBe(digests[0]);
    expect(second.messages.filter((m) => m.text.startsWith('Understood.'))).toHaveLength(1);
    expect(orphans(second.messages)).toEqual([]);
  });

  it('does nothing when the only old content is an earlier digest', async () => {
    const first = await condenseOldProse(history(10), options);
    const again = await condenseOldProse(first.messages, options);
    expect(again.applied).toBe('keep');
    expect(again.messages).toEqual(first.messages);
  });

  it('keeps digest size bounded over repeated compactions', async () => {
    let messages = history(10);
    const sizes: number[] = [];
    for (let round = 0; round < 12; round++) {
      messages = (await condenseOldProse(messages, options)).messages;
      sizes.push(messages[0]!.text.length);
      messages = [...messages, ...Array.from({ length: 6 }, (_, i) => turn(100 + round * 6 + i)).flat()];
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(12_000);
  });

  it('summarize uses the summarizer, folds a previous summary into the request', async () => {
    const prompts: string[] = [];
    const summarize: ProseSummarizer = async ({ prompt }) => {
      prompts.push(prompt);
      return 'SUMMARY TEXT';
    };
    const sOptions = { oldProse: 'summarize', recentTurns: 4 } as const;
    const first = await condenseOldProse(history(10), sOptions, summarize);
    expect(first.applied).toBe('summarize');
    expect(parseCondensed(first.messages[0]!)).toMatchObject({ kind: 'summary', turns: 6, body: 'SUMMARY TEXT' });
    const second = await condenseOldProse([...first.messages, ...turn(11), ...turn(12)], sOptions, summarize);
    expect(prompts[1]).toContain('Previous summary');
    expect(prompts[1]).toContain('SUMMARY TEXT');
    expect(parseCondensed(second.messages[0]!)!.turns).toBe(8);
    expect(second.messages.filter((m) => parseCondensed(m))).toHaveLength(1);
  });

  it('summarize falls back to the digest without a summarizer, on failure or an empty reply', async () => {
    const sOptions = { oldProse: 'summarize', recentTurns: 4 } as const;
    expect((await condenseOldProse(history(10), sOptions)).applied).toBe('digest');
    const failing = await condenseOldProse(history(10), sOptions, async () => {
      throw new Error('boom');
    });
    expect(failing.applied).toBe('digest');
    expect((await condenseOldProse(history(10), sOptions, async () => '  ')).applied).toBe('digest');
  });

  it('leaves the messages unchanged when the replacement would not be smaller', async () => {
    const tiny = [...Array.from({ length: 6 }, (_, i) => msg('user', `p${i}`))];
    const out = await condenseOldProse(tiny, { oldProse: 'digest', recentTurns: 2 });
    expect(out.applied).toBe('keep');
  });
});

describe('compact with oldProse', () => {
  const asker: JevAsker = {
    async ask(_state, questions) {
      return {
        answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: 0.1 }])),
      };
    },
  };

  it('pins the digest, keeps tool pairs whole across the cut, and reports stats against the original', async () => {
    const messages = history(14);
    const result = await compact(messages, asker, { oldProse: 'digest', recentTurns: 5, preserveRecentMessages: 4 });
    expect(result.stats.oldProse).toBe('digest');
    expect(result.stats.oldProseReplaced).toBe(9 * 4);
    expect(result.stats.messagesBefore).toBe(messages.length);
    expect(result.messages[0]!.text).toMatch(/^\[fast-jev-compaction digest of 9 earlier turns/);
    expect(orphans(result.messages)).toEqual([]);
    const pinnedTail = result.messages.slice(-4);
    expect(pinnedTail).toEqual(messages.slice(-4));
    const keep = await compact(messages, asker, { preserveRecentMessages: 4 });
    expect(keep.stats.oldProse).toBe('keep');
    expect(result.stats.charsAfter).toBeLessThan(keep.stats.charsAfter);
  });
});
