import { buildJevRequest, JevRequestError, parseJevResponse, wellFormedJson, type JevRequest } from './request.js';
import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

/**
 * OpenAI's Decisions API (`POST /v1/decisions`, public beta since 2026-10-06),
 * an alternative to Jev's System One endpoint. It takes the state as text and
 * the questions as an array of named `predicate`s, and answers with an array
 * in question order. This module maps both ways so the rest of the package
 * keeps speaking System One. The library only asks `noul` questions; those
 * become predicates. Ported from deadczarvc-labs/jev-factkeep-compaction.
 */

export const OPENAI_DECISIONS_URL = 'https://api.openai.com/v1/decisions';
/** The only model the Decisions beta serves. */
export const DECISIONS_MODEL = 'gpt-6-luna';

type Predicate = { type: 'predicate'; name: string; instructions: string };

function predicates(questions: JevQuestions): Predicate[] {
  return Object.entries(questions).map(([name, question]) => {
    if (question.type !== 'noul') {
      throw new Error(`the Decisions wire takes noul questions only (${name} is ${question.type})`);
    }
    // A predicate has no criteria field: they go into the instructions.
    const c = question.criteria;
    const criteria =
      c && (c.true !== undefined || c.false !== undefined)
        ? `\nTrue when: ${c.true ?? 'the condition holds'}.\nFalse when: ${c.false ?? 'it does not'}.`
        : '';
    return { type: 'predicate', name, instructions: `${question.instructions}${criteria}` };
  });
}

/** The HTTP request for one Decisions call, for any fetch-like transport. */
export function buildDecisionsRequest(
  params: { apiKey: string; model?: string; baseUrl?: string },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  const input = typeof state === 'string' ? state : JSON.stringify(state);
  return {
    url: params.baseUrl ?? OPENAI_DECISIONS_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DECISIONS_MODEL,
      input: wellFormedJson(input),
      questions: predicates(questions),
    }),
  };
}

/** Who answers the questions: TypeSafe's Jev (System One) or OpenAI's Decisions API. */
export type JevProvider = 'jev' | 'openai';

export interface JevWire {
  build: (params: { apiKey: string; model?: string; baseUrl?: string }, state: JevState, questions: JevQuestions) => JevRequest;
  parse: (status: number, ok: boolean, text: string) => JevResponse;
  /** The environment variable the key is read from. */
  keyName: 'TYPESAFE_API_KEY' | 'OPENAI_API_KEY';
}

export function wireFor(provider: JevProvider): JevWire {
  return provider === 'openai'
    ? { build: buildDecisionsRequest, parse: parseDecisionsResponse, keyName: 'OPENAI_API_KEY' }
    : { build: buildJevRequest, parse: parseJevResponse, keyName: 'TYPESAFE_API_KEY' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Maps a Decisions response onto the System One shape. A refusal answers 1:
 * the model declined to judge, so the call and its result are kept.
 */
export function parseDecisionsResponse(status: number, ok: boolean, text: string): JevResponse {
  if (!ok) throw new JevRequestError(status, text.slice(0, 200));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['answers'])) {
    throw new Error('Jev response is missing answers');
  }
  const answers: Record<string, JevAnswer> = {};
  for (const raw of parsed['answers']) {
    if (!isRecord(raw) || typeof raw['name'] !== 'string') continue;
    if (raw['type'] === 'refusal') answers[raw['name']] = { type: 'noul', noul: 1 };
    else if (raw['type'] === 'predicate' && typeof raw['probability'] === 'number') {
      answers[raw['name']] = { type: 'noul', noul: raw['probability'] };
    }
  }
  return { answers };
}
