import type { Message } from '../types.js';
import { archiveDir, archiveRows, loadArchive, type ArchiveFs } from './archive.js';
import { RECALL_TOOL, resolveRefs, runRecall, type RecallRequest } from './recall.js';
import { entriesFromGroups } from './transcript.js';

export { RECALL_TOOL };

/**
 * The recall tool as the plugin offers it: its name, description and input
 * schema, the request its calls carry, and the answer from a session's
 * archive and live rows. Host calls stay in the hook; this takes plain values.
 */

/** The short name `$.tool.register` takes; the model calls RECALL_TOOL. */
export const RECALL_NAME = 'recall';

/** Archives of sessions untouched this long are emptied. */
export const RECALL_MAX_AGE_MS = 30 * 86_400_000;

export const RECALL_DESCRIPTION = [
  'Recall earlier parts of this session, including the tool calls and results that compaction cut or dropped.',
  'Use it before saying the context is gone, and instead of running a tool again to see its old output.',
  '',
  'One per call:',
  '- query: keywords (ranked) or a regex, e.g. "redis timeout"; 5 hits per page.',
  '- expand: ["#N" or a tool_use_id, ...]: those entries in full, a call with its input and result.',
  '- range: [from, to]: entries #from..#to in order, one line each.',
  'Add page for more query or range results, and offset to continue a long expand.',
  'A compaction note names the tool_use_id to expand.',
].join('\n');

export const RECALL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Keywords, ranked by relevance; a regex also works.' },
    expand: {
      type: 'array',
      items: { type: ['string', 'number'] },
      description: 'Entries to return in full: "#N" from recall results, or a tool_use_id.',
    },
    range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[from, to] entry numbers.' },
    page: { type: 'number', description: 'Page of query or range results, from 1.' },
    offset: { type: 'number', description: 'For expand: where to continue, from a cut note.' },
  },
};

/** The request a recall call carries, loosely checked. */
export function recallRequest(e: Record<string, unknown>): RecallRequest {
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const range = Array.isArray(e['range']) ? e['range'].map(Number) : undefined;
  const expand = typeof e['expand'] === 'string' || typeof e['expand'] === 'number' ? [e['expand']] : e['expand'];
  return {
    ...(typeof e['query'] === 'string' && { query: e['query'] }),
    ...(Array.isArray(expand) && { expand: expand.filter((r) => typeof r === 'string' || typeof r === 'number') }),
    ...(range?.length === 2 && range.every(Number.isFinite) && { range: [range[0]!, range[1]!] as const }),
    ...(number(e['page']) !== undefined && { page: number(e['page']) }),
    ...(number(e['offset']) !== undefined && { offset: number(e['offset']) }),
  };
}

/**
 * Whether `path` is a file Claude Code saved a large output to:
 * `<config>/projects/<project>/<session>/tool-results/<name>`. The path comes
 * from text in a tool result, which a fetched page or file can forge, and
 * recall reads it without the permission check a Read would get.
 */
export function isSavedOutput(path: string, configDir: string): boolean {
  const normal = path.replace(/\\/g, '/');
  const root = `${configDir.replace(/\\/g, '/').replace(/\/+$/, '')}/projects/`;
  return (
    normal.toLowerCase().startsWith(root.toLowerCase()) &&
    !normal.split('/').includes('..') &&
    /^[^/]+\/[^/]+\/tool-results\/[^/]+$/.test(normal.slice(root.length))
  );
}

/** Answers a recall call from a session's archive under `configDir` and its live rows. */
export async function answerRecall(
  fs: ArchiveFs,
  configDir: string | undefined,
  sessionId: string,
  live: readonly Message[],
  request: RecallRequest,
): Promise<string> {
  const archived = configDir ? await loadArchive(fs, archiveDir(configDir, sessionId)) : [];
  const entries = entriesFromGroups([...archived, live]);
  // Outputs Claude Code saved to a file, for the entries asked for in full.
  const saved = new Map<string, string>();
  for (const entry of resolveRefs(entries, request.expand ?? []).found) {
    if (entry.kind !== 'call' || !entry.savedTo || !configDir || !isSavedOutput(entry.savedTo, configDir)) continue;
    const text = await fs.read(entry.savedTo).catch(() => undefined);
    if (text !== undefined) saved.set(entry.savedTo, text);
  }
  return runRecall(entries, request, { readFile: (path) => saved.get(path) });
}

/** Saves the rows a compaction received in the session's archive. */
export function archiveSession(fs: ArchiveFs, configDir: string, sessionId: string, rows: readonly Message[]) {
  return archiveRows(fs, archiveDir(configDir, sessionId), rows);
}
