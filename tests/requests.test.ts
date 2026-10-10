import { describe, expect, it } from 'vitest';
import {
  collectToolCalls,
  compact,
  fitState,
  JevRequestError,
  JevTransportError,
  MAX_INSTRUCTION_CHARS,
  parseJevResponse,
  type JevAsker,
  type JevQuestions,
  type Message,
} from '../src/index.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

/** A user prompt, then `n` Read calls with results, then a closing exchange. */
function transcript(n: number): Message[] {
  const body = 'export const x = 1;\n'.repeat(40);
  const calls = Array.from({ length: n }, (_, i) => [
    message('assistant', '', { toolUses: [{ tool_use_id: `c${i}`, tool: 'Read', input: { file_path: `f${i}.ts` }, text: body }] }),
    message('user', '', { toolResults: [{ tool_use_id: `c${i}`, text: body, isError: false }] }),
  ]).flat();
  return [message('user', 'Fix the bug.'), ...calls, message('assistant', 'Done.'), message('user', 'thanks')];
}

/** One request per call: the request budget fits the state plus one call's two questions. */
function oneCallPerRequest(messages: Message[]) {
  const stateTokens = fitState(messages, collectToolCalls(messages, 1), {
    maxStateTokens: 25_000,
    preserveRecentMessages: 1,
    goal: '',
  }).tokens;
  return { keepMode: 'threshold' as const, preserveRecentMessages: 1, maxRequestTokens: stateTokens + 150 };
}

type Reply = number | Error;

/** Answers 0.1 for everything, or fails as `fail(callId, attempt)` says. */
function jev(fail: (id: string, attempt: number) => Reply = () => 0.1) {
  let inFlight = 0;
  let peak = 0;
  const attempts = new Map<string, number>();
  const asker: JevAsker = {
    async ask(_state, questions: JevQuestions) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      const id = Object.keys(questions)[0]!.replace(/^(call|result)_/, '');
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      const reply = fail(id, attempt);
      if (reply instanceof Error) throw reply;
      return {
        answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: reply }])),
      };
    },
  };
  return { asker, peak: () => peak, attempts };
}

const noWait = { sleep: async () => {} };

describe('/compact instructions', () => {
  it('adds them to the goal Jev sees, capped at MAX_INSTRUCTION_CHARS', async () => {
    const states: { goal: string }[] = [];
    const asker: JevAsker = {
      async ask(state, questions) {
        states.push(state as { goal: string });
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, noul: 0.5 }])) };
      },
    };
    await compact(transcript(2), asker, { preserveRecentMessages: 1, instructions: `  keep the API design ${'x'.repeat(5000)}` });
    const goal = states[0]!.goal;
    expect(goal).toMatch(/^Fix the bug\.\n/);
    expect(goal).toContain('The user asked this compaction to keep: keep the API design');
    expect(goal.length).toBeLessThan(MAX_INSTRUCTION_CHARS + 200);

    states.length = 0;
    await compact(transcript(2), asker, { preserveRecentMessages: 1, instructions: '   ' });
    expect(states[0]!.goal).not.toContain('asked this compaction');
  });
});

describe('Jev request policy', () => {
  it('classifies HTTP failures', () => {
    expect(() => parseJevResponse(429, false, 'slow down')).toThrow(JevRequestError);
    try {
      parseJevResponse(503, false, 'busy');
    } catch (error) {
      expect((error as JevRequestError).status).toBe(503);
      expect((error as Error).message).toBe('Jev request failed (503): busy');
    }
  });

  it('runs at most maxConcurrentRequests at once', async () => {
    const messages = transcript(10);
    const j = jev();
    const out = await compact(messages, j.asker, { ...oneCallPerRequest(messages), maxConcurrentRequests: 3 }, noWait);
    expect(out.stats.requests).toBe(10);
    expect(j.peak()).toBe(3);
  });

  it('retries a 429 or 5xx once', async () => {
    const messages = transcript(4);
    const j = jev((id, attempt) => (attempt === 1 && (id === 't2' || id === 't3') ? new JevRequestError(id === 't2' ? 429 : 502, 'x') : 0.1));
    const out = await compact(messages, j.asker, oneCallPerRequest(messages), noWait);
    expect(j.attempts.get('t2')).toBe(2);
    expect(j.attempts.get('t3')).toBe(2);
    expect(out.decisions.filter((d) => d.reason !== 'pinned').every((d) => d.action === 'stub_call')).toBe(true);
    expect(out.stats.requestsFailed).toBe(0);
  });

  it('keeps the calls of a request that still fails and uses the rest', async () => {
    const messages = transcript(4);
    const j = jev((id) => (id === 't3' ? new JevRequestError(500, 'down') : 0.1));
    const out = await compact(messages, j.asker, oneCallPerRequest(messages), noWait);
    expect(j.attempts.get('t3')).toBe(2);
    const byId = new Map(out.decisions.map((d) => [d.id, d.action]));
    expect(byId.get('t3')).toBe('keep');
    expect(byId.get('t2')).toBe('stub_call');
    expect(out.stats.requestsFailed).toBe(1);
  });

  it('starts no more requests after a 401/403 or no answer, and throws when nothing was answered', async () => {
    for (const error of [new JevRequestError(401, 'bad key'), new JevTransportError(new Error('ECONNREFUSED'))]) {
      const messages = transcript(8);
      const j = jev(() => error);
      await expect(
        compact(messages, j.asker, { ...oneCallPerRequest(messages), maxConcurrentRequests: 2 }, noWait),
      ).rejects.toBe(error);
      const sent = [...j.attempts.values()].reduce((a, b) => a + b, 0);
      expect(sent).toBe(2);
    }
  });

  it('does not retry other failures', async () => {
    const messages = transcript(2);
    const j = jev(() => new Error('Jev returned malformed JSON'));
    await expect(compact(messages, j.asker, oneCallPerRequest(messages), noWait)).rejects.toThrow('malformed');
    expect([...j.attempts.values()]).toEqual([1, 1]);
  });
});
