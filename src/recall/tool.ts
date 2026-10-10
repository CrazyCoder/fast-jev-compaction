import { RECALL_TOOL, type RecallRequest } from './recall.ts';

export { RECALL_TOOL };

/**
 * The recall tool as the plugin offers it: its name, description and input
 * schema, the request its calls carry, and the command that answers it. The
 * answer comes from src/recall/cli.ts, run by the pinned Node of
 * tools/node.cmd, which reads the session transcript at any size; host calls
 * stay in the hook.
 */

/** The short name `$.tool.register` takes; the model calls RECALL_TOOL. */
export const RECALL_NAME = 'recall';

export const RECALL_DESCRIPTION = [
  'Recall earlier parts of this session, including the tool calls and results that compaction cut or dropped, and of past sessions in this project or others.',
  'Use it before saying the context is gone, instead of running a tool again to see its old output, and when the user points at earlier work ("as we did in the billing-api session").',
  '',
  'One per call:',
  '- query: keywords (ranked) or a regex, e.g. "redis timeout"; 5 hits per page.',
  '- expand: ["#N" or a tool_use_id, ...]: those entries in full, a call with its input and result.',
  '- range: [from, to]: entries #from..#to in order, one line each.',
  '- touched: true for the files changed in this session and the calls that changed them; a part of a path for every call on the files it matches, reads included.',
  'Add page for more query, range or touched results, and offset to continue a long expand.',
  '- sessions: keywords searched in the other sessions of this project; with project: "<part of its folder or path>" in another project, or project: "all" in every one. Each hit names its session id.',
  'session: "<id>" runs query, expand, range or touched on that session instead of this one.',
  'Subagents keep their own transcripts: agent: "list" names them; agent: "<id or part of its name>" runs the request on one, agent: "all" on the session and all of them. expand finds a subagent call by its tool_use_id without it.',
  'A compaction note names the tool_use_id to expand. A tool_use_id always names the same call; #N can shift as the session grows.',
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
    touched: {
      type: ['boolean', 'string'],
      description: 'true: files changed and by which calls; a part of a path: every call on the files it matches.',
    },
    sessions: { type: 'string', description: 'Keywords to search in other sessions.' },
    project: {
      type: 'string',
      description: 'For sessions: "all", or a part of a project folder or path; this project when absent.',
    },
    session: { type: 'string', description: 'Run the request on this other session: its id, or 8+ leading characters.' },
    agent: {
      type: 'string',
      description: 'Subagent transcripts: "list", "all" (with this session), or a part of an agent id or name.',
    },
    page: { type: 'number', description: 'Page of query, range or touched results, from 1.' },
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
    ...((e['touched'] === true || typeof e['touched'] === 'string') && { touched: e['touched'] as true | string }),
    ...(typeof e['agent'] === 'string' && { agent: e['agent'] }),
    ...(typeof e['sessions'] === 'string' && { sessions: e['sessions'] }),
    ...(typeof e['project'] === 'string' && { project: e['project'] }),
    ...(typeof e['session'] === 'string' && { session: e['session'] }),
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

/**
 * How to run src/recall/cli.ts under tools/node.cmd from the plugin folder
 * `root`: through bash on Linux and macOS; on Windows through cmd.exe from
 * the tools folder with paths relative to it, so cmd.exe never parses `root`
 * (it can hold a space, `&` or `%`). The request goes on stdin.
 */
export function recallCommand(root: string): { argv: string[]; cwd?: string } {
  if (/^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\')) {
    const base = root.replace(/[\\/]+$/, '');
    return {
      argv: ['cmd.exe', '/d', '/s', '/c', '.\\node.cmd', '..\\src\\recall\\cli.ts'],
      cwd: `${base}\\tools`,
    };
  }
  const base = root.replace(/\/+$/, '');
  return { argv: ['bash', `${base}/tools/node.cmd`, `${base}/src/recall/cli.ts`] };
}
