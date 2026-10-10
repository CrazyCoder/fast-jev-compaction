import type { Message } from '../../src/index.js';

/** Session rows for tests: a prompt, a call with no text, and a call's result. */
export const userRow = (text: string): Message => ({ role: 'user', text, toolUses: [] });

export const callRow = (id: string, text = '', input: Record<string, unknown> = {}): Message => ({
  role: 'assistant',
  text,
  toolUses: [{ tool_use_id: id, tool: 'Read', input }],
});

export const resultRow = (id: string, text: string): Message => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text, isError: false }],
});
