import { describe, expect, it } from 'vitest';

import { recordedAsker } from '../tools/replay/askers.js';
import { detectLoss, extractTokens } from '../tools/replay/loss.js';
import type { Message } from '../src/index.js';

const assistant = (text: string, uses: Message['toolUses'] = []): Message => ({ role: 'assistant', text, toolUses: uses });
const user = (text: string, results: NonNullable<Message['toolResults']> = []): Message => ({
  role: 'user',
  text,
  toolUses: [],
  ...(results.length > 0 ? { toolResults: results } : {}),
});
const call = (id: string, tool: string, input: Record<string, unknown>) => ({ tool_use_id: id, tool, input });

describe('extractTokens', () => {
  it('keeps paths, hex, uuids, distinctive identifiers and long numbers; drops plain words', () => {
    const tokens = extractTokens(
      'see /repo/src/widget_parser.ts hash deadbeef01 id 123e4567-e89b-12d3-a456-426614174000 ' +
        'call parseWidgetInput with 1234567 and something ordinary 42',
    );
    expect(tokens).toContain('/repo/src/widget_parser.ts');
    expect(tokens).toContain('deadbeef01');
    expect(tokens).toContain('123e4567-e89b-12d3-a456-426614174000');
    expect(tokens).toContain('parseWidgetInput');
    expect(tokens).toContain('1234567');
    expect(tokens).not.toContain('something');
    expect(tokens).not.toContain('ordinary');
  });
});

describe('detectLoss', () => {
  const big = 'export const SECRET_TOKEN_NAME = 1; path /repo/src/deep/module_name.ts';
  const degraded = [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'x' }, resultText: big }];
  /** A Read whose result holds the tokens, then an Edit that types one of them. */
  const readThenEdit = () => [
    assistant('', [call('a', 'Read', { file_path: 'x' })]),
    user('', [{ tool_use_id: 'a', text: big }]),
    assistant('', [call('b', 'Edit', { file_path: '/repo/src/deep/module_name.ts' })]),
  ];

  it('flags a lost token the model later types into a call before seeing it again', () => {
    const original = readThenEdit();
    const [verdict] = detectLoss({ original, from: 2, compacted: [original[0]!], degraded });
    expect(verdict!.lostAndNeeded).toBe(true);
    expect(verdict!.neededTokens).toBeGreaterThan(0);
  });

  it('does not count a token the compacted history still holds', () => {
    const original = readThenEdit();
    const compacted = [assistant('kept /repo/src/deep/module_name.ts and SECRET_TOKEN_NAME')];
    const [verdict] = detectLoss({ original, from: 2, compacted, degraded });
    expect(verdict!.lostAndNeeded).toBe(false);
  });

  it('does not count a token a later result showed before the call used it', () => {
    const original = [
      assistant('', [call('a', 'Read', { file_path: 'x' })]),
      user('', [{ tool_use_id: 'a', text: big }]),
      assistant('', [call('c', 'Bash', { command: 'ls' })]),
      user('', [{ tool_use_id: 'c', text: '/repo/src/deep/module_name.ts' }]),
      assistant('', [call('b', 'Edit', { file_path: '/repo/src/deep/module_name.ts' })]),
    ];
    const [verdict] = detectLoss({ original, from: 2, compacted: [original[0]!], degraded });
    expect(verdict!.lostAndNeeded).toBe(false);
  });

  it('respects the turn window', () => {
    const original = [
      assistant('', [call('a', 'Read', { file_path: 'x' })]),
      user('', [{ tool_use_id: 'a', text: big }]),
      assistant('one'),
      assistant('two'),
      assistant('', [call('b', 'Edit', { file_path: '/repo/src/deep/module_name.ts' })]),
    ];
    const args = { original, from: 2, compacted: [original[0]!], degraded };
    expect(detectLoss({ ...args, turns: 2 })[0]!.lostAndNeeded).toBe(false);
    expect(detectLoss({ ...args, turns: 3 })[0]!.lostAndNeeded).toBe(true);
  });

  it('never looks past `until`', () => {
    const original = readThenEdit();
    const args = { original, from: 2, compacted: [original[0]!], degraded };
    expect(detectLoss({ ...args, until: 2 })[0]!.lostAndNeeded).toBe(false);
    expect(detectLoss({ ...args, until: 3 })[0]!.lostAndNeeded).toBe(true);
  });

  it('flags an identical re-issued call, whatever its key order', () => {
    const original = [
      assistant('', [call('a', 'Bash', { command: 'ls', cwd: '/x' })]),
      user('', [{ tool_use_id: 'a', text: 'out' }]),
      assistant('', [call('b', 'Bash', { cwd: '/x', command: 'ls' })]),
    ];
    const d = [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'ls', cwd: '/x' }, resultText: 'out' }];
    expect(detectLoss({ original, from: 2, compacted: [], degraded: d })[0]!.rerun).toBe(true);
  });
});

describe('recordedAsker', () => {
  const messages = [
    assistant('', [call('a', 'Read', {})]),
    user('', [{ tool_use_id: 'a', text: 'r' }]),
  ];
  it('refuses a point whose tool names do not line up with the log', () => {
    const event = { messageIndex: 2, entries: [{ id: 't1', tool: 'Grep', action: 'keep', keepCall: 1, keepResult: 1 }] };
    expect(recordedAsker({ messages, event })).toBeNull();
  });
  it('answers logged scores', async () => {
    const event = { messageIndex: 2, entries: [{ id: 't1', tool: 'Read', action: 'drop_call', keepCall: 0.2, keepResult: 0.1 }] };
    const asker = recordedAsker({ messages, event })!;
    const { answers } = await asker.ask({}, { call_t1: { type: 'noul', instructions: '' }, result_t1: { type: 'noul', instructions: '' } });
    expect(answers).toEqual({ call_t1: { noul: 0.2 }, result_t1: { noul: 0.1 } });
  });
});
