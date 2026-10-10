import { wireFor, type JevProvider } from './decisions.js';
import { JevTransportError } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions {
  /** `jev` (TypeSafe System One) or `openai` (OpenAI Decisions API). Defaults to `jev`. */
  provider?: JevProvider;
  /** Defaults to `process.env.TYPESAFE_API_KEY`, or `OPENAI_API_KEY` for `openai`. */
  apiKey?: string;
  /** Defaults to `jev-latest`, or `gpt-6-luna` for `openai`. */
  model?: string;
  /** Defaults to the provider's endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Asks Jev (or OpenAI's Decisions API) over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly wire;
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    this.wire = wireFor(options.provider ?? 'jev');
    this.apiKey = options.apiKey ?? process.env[this.wire.keyName] ?? '';
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error(`${this.wire.keyName} is not configured`);
    const request = this.wire.build(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    let response: Response;
    try {
      response = await this.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    } catch (error) {
      throw new JevTransportError(error);
    }
    return this.wire.parse(response.status, response.ok, await response.text());
  }
}
