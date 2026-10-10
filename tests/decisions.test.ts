import { describe, expect, it } from 'vitest';
import { getApiKey, jevAsker, resolveHookConfig } from '../hooks/fast-jev.ts';
import {
  buildDecisionsRequest,
  DECISIONS_MODEL,
  JevClient,
  JevRequestError,
  OPENAI_DECISIONS_URL,
  parseDecisionsResponse,
} from '../src/index.js';

const questions = {
  call_t1: { type: 'noul' as const, instructions: 'Tool call t1 should stay' },
  result_t1: { type: 'noul' as const, instructions: 'The output of t1 should stay' },
};

describe('OpenAI Decisions wire', () => {
  it('sends the state as text and the noul questions as named predicates', () => {
    const request = buildDecisionsRequest({ apiKey: 'sk-test' }, { goal: 'g', history: ['a'] }, questions);
    expect(request.url).toBe(OPENAI_DECISIONS_URL);
    expect(request.headers.authorization).toBe('Bearer sk-test');
    expect(JSON.parse(request.body)).toEqual({
      model: DECISIONS_MODEL,
      input: JSON.stringify({ goal: 'g', history: ['a'] }),
      questions: [
        { type: 'predicate', name: 'call_t1', instructions: 'Tool call t1 should stay' },
        { type: 'predicate', name: 'result_t1', instructions: 'The output of t1 should stay' },
      ],
    });
    expect(buildDecisionsRequest({ apiKey: 'k', baseUrl: 'http://gw/v1/decisions', model: 'm' }, 's', questions).url).toBe(
      'http://gw/v1/decisions',
    );
  });

  it('folds noul criteria into the predicate instructions and refuses other question types', () => {
    const body = JSON.parse(
      buildDecisionsRequest({ apiKey: 'k' }, 's', {
        q: { type: 'noul', instructions: 'It is a bug', criteria: { true: 'broken', false: 'fine' } },
      }).body,
    );
    expect(body.questions[0].instructions).toBe('It is a bug\nTrue when: broken.\nFalse when: fine.');
    expect(() =>
      buildDecisionsRequest({ apiKey: 'k' }, 's', { q: { type: 'choice', instructions: 'x', criteria: { a: null } } } as never),
    ).toThrow(/noul/);
  });

  it('reads predicate answers as noul; a refusal keeps the call', () => {
    const response = parseDecisionsResponse(
      200,
      true,
      JSON.stringify({
        model: 'gpt-6-luna',
        answers: [
          { type: 'predicate', name: 'call_t1', probability: 0.12 },
          { type: 'refusal', name: 'result_t1' },
        ],
      }),
    );
    expect(response.answers).toEqual({
      call_t1: { type: 'noul', noul: 0.12 },
      result_t1: { type: 'noul', noul: 1 },
    });
  });

  it('fails like the System One wire on HTTP errors and bad bodies', () => {
    expect(() => parseDecisionsResponse(429, false, 'slow')).toThrow(JevRequestError);
    expect(() => parseDecisionsResponse(200, true, 'not json')).toThrow('malformed JSON');
    expect(() => parseDecisionsResponse(200, true, '{"answers":{}}')).toThrow('missing answers');
  });

  it('JevClient speaks it with provider: openai', async () => {
    let seen = '';
    const client = new JevClient({
      provider: 'openai',
      apiKey: 'sk-test',
      fetch: (async (url: string) => {
        seen = url;
        return new Response(JSON.stringify({ answers: [{ type: 'predicate', name: 'call_t1', probability: 0.5 }] }));
      }) as typeof fetch,
    });
    const out = await client.ask('s', { call_t1: questions.call_t1 });
    expect(seen).toBe(OPENAI_DECISIONS_URL);
    expect(out.answers['call_t1']).toEqual({ type: 'noul', noul: 0.5 });
  });
});

describe('provider option in the hook', () => {
  it('defaults to Jev; openai switches model and key', async () => {
    expect(resolveHookConfig({})).toMatchObject({ provider: 'jev', model: 'jev-latest' });
    expect(resolveHookConfig({ provider: 'openai' })).toMatchObject({ provider: 'openai', model: DECISIONS_MODEL });
    expect(resolveHookConfig({ provider: 'openai', model: 'gpt-6-luna-2' })).toMatchObject({ model: 'gpt-6-luna-2' });
    // A Jev model name left in the settings from before the switch does not reach OpenAI.
    expect(resolveHookConfig({ provider: 'openai', model: 'jev-latest' })).toMatchObject({ model: DECISIONS_MODEL });
    expect(resolveHookConfig({ provider: 'bogus' })).toMatchObject({ provider: 'jev' });

    const env = { TYPESAFE_API_KEY: 'ts-key', OPENAI_API_KEY: 'sk-key' } as Record<string, string>;
    const $ = {
      env: { get: async (name: string) => env[name] },
      settings: { read: async () => ({}) },
      fs: { read: async () => '' },
    };
    expect(await getApiKey($, resolveHookConfig({}))).toBe('ts-key');
    expect(await getApiKey($, resolveHookConfig({ provider: 'openai' }))).toBe('sk-key');
    delete env['OPENAI_API_KEY'];
    expect(await getApiKey($, resolveHookConfig({ provider: 'openai' }))).toBeUndefined();
  });

  it('never hands the Jev key or the Jev endpoint to the openai provider', async () => {
    const config = resolveHookConfig({ provider: 'openai', apiKey: 'ts-key', baseUrl: 'https://openrouter.ai/api/alpha/decisions' });
    expect(config).not.toHaveProperty('apiKey');
    expect(config).not.toHaveProperty('baseUrl');
    const $ = {
      env: { get: async (name: string) => (name === 'OPENAI_API_KEY' ? 'sk-key' : undefined) },
      settings: { read: async () => ({}) },
      fs: { read: async () => '' },
    };
    expect(await getApiKey($, config)).toBe('sk-key');
    expect(resolveHookConfig({ apiKey: 'ts-key', baseUrl: 'https://gw' })).toMatchObject({ apiKey: 'ts-key', baseUrl: 'https://gw' });
  });

  it('asks the Decisions endpoint when the provider is openai', async () => {
    const urls: string[] = [];
    const asker = jevAsker(
      async (url) => {
        urls.push(url);
        return { status: 200, ok: true, text: JSON.stringify({ answers: [{ type: 'predicate', name: 'call_t1', probability: 0.3 }] }) };
      },
      'sk-key',
      DECISIONS_MODEL,
      undefined,
      undefined,
      'openai',
    );
    expect((await asker.ask('s', { call_t1: questions.call_t1 })).answers['call_t1']).toEqual({ type: 'noul', noul: 0.3 });
    expect(urls).toEqual([OPENAI_DECISIONS_URL]);
  });
});
