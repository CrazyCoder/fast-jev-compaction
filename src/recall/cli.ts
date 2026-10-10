/**
 * Answers one recall request from the session transcript. Run by the pinned
 * Node of tools/node.cmd (Node strips the types): the request comes as JSON on
 * stdin, `{ configDir, sessionId, request }`, and the answer goes to stdout.
 * Node reads the transcript at any size, which a hook's `$.fs.read` cannot.
 */
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolveRefs, runRecall, type RecallDeps, type RecallRequest } from './recall.ts';
import { isSavedOutput } from './tool.ts';
import { transcriptReader, type Entry } from './transcript.ts';

export type CliInput = { configDir: string; sessionId: string; request: RecallRequest };

/** A subagent of the session: `<session>/subagents/agent-<id>.jsonl` and its `.meta.json`. */
type Agent = { id: string; name: string; startedBy?: string; file: string };

/** The session's subagents, from their meta files. */
function sessionAgents(sessionDir: string): Agent[] {
  const dir = join(sessionDir, 'subagents');
  if (!existsSync(dir)) return [];
  const agents: Agent[] = [];
  for (const name of readdirSync(dir)) {
    const id = /^agent-([\w-]+)\.jsonl$/.exec(name)?.[1];
    if (!id) continue;
    let meta: { agentType?: unknown; description?: unknown; toolUseId?: unknown } = {};
    try {
      meta = JSON.parse(readFileSync(join(dir, `agent-${id}.meta.json`), 'utf8')) as typeof meta;
    } catch {
      // An agent without meta is still searchable, by its id.
    }
    const type = typeof meta.agentType === 'string' ? meta.agentType : 'agent';
    const description = typeof meta.description === 'string' ? meta.description : id;
    agents.push({
      id,
      name: `${type}: ${description}`,
      ...(typeof meta.toolUseId === 'string' && { startedBy: meta.toolUseId }),
      file: join(dir, name),
    });
  }
  return agents;
}

async function readEntries(file: string, sidechain = false): Promise<Entry[]> {
  const reader = transcriptReader({ sidechain });
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) reader.line(line);
  return reader.entries;
}

/** Each agent's entries, labelled with its name and numbered on from `after`. */
async function agentEntries(agents: readonly Agent[], after: number): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const agent of agents) {
    for (const entry of await readEntries(agent.file, true)) out.push({ ...entry, n: after + out.length + 1, agent: agent.name });
  }
  return out;
}

async function listAgents(agents: readonly Agent[]): Promise<string> {
  if (agents.length === 0) return 'This session has no subagent transcripts.';
  const lines = [];
  for (const agent of agents) {
    const started = agent.startedBy ? `started by ${agent.startedBy}; ` : '';
    lines.push(`${agent.id} ${agent.name} (${started}${(await readEntries(agent.file, true)).length} entries)`);
  }
  return [
    `Subagents of this session (${agents.length}):`,
    ...lines,
    'Search one with agent: "<id or part of its name>", or all with agent: "all".',
  ].join('\n');
}

/** `<configDir>/projects/<project>/<sessionId>.jsonl`, whichever project holds it. */
export function findTranscript(configDir: string, sessionId: string): string | undefined {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return undefined;
  for (const project of readdirSync(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const file = join(projects, project.name, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

export async function answer({ configDir, sessionId, request }: CliInput): Promise<string> {
  const file = /^[\w-]+$/.test(sessionId) ? findTranscript(configDir, sessionId) : undefined;
  if (!file) return 'Recall: no transcript found for this session.';
  const deps: RecallDeps = {
    readFile: (path) => {
      if (!isSavedOutput(path, configDir)) return undefined;
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
  const { agent, ...rest } = request;
  const main = await readEntries(file);
  const agents = sessionAgents(file.replace(/\.jsonl$/, ''));
  const started = new Map(agents.flatMap((a) => (a.startedBy ? [[a.startedBy, a.id] as const] : [])));
  for (const entry of main) if (entry.kind === 'call' && started.has(entry.id)) entry.agentId = started.get(entry.id)!;

  const wanted = agent?.trim();
  if (wanted === 'list') return listAgents(agents);
  if (wanted) {
    const part = wanted.toLowerCase();
    const picked = wanted === 'all' ? agents : agents.filter((a) => `${a.id} ${a.name}`.toLowerCase().includes(part));
    if (picked.length === 0) return `No subagent matches "${wanted.slice(0, 100)}". agent: "list" shows them.`;
    const own = wanted === 'all' ? main : [];
    return runRecall([...own, ...(await agentEntries(picked, own.length))], rest, deps);
  }
  // A tool_use_id the session's transcript does not hold may be a subagent's.
  if (rest.expand?.length && resolveRefs(main, rest.expand).missing.length > 0 && agents.length > 0) {
    return runRecall([...main, ...(await agentEntries(agents, main.length))], rest, deps);
  }
  return runRecall(main, rest, deps);
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  // No request: the hook only makes sure tools/node.cmd has downloaded Node.
  if (!input.trim()) return;
  try {
    process.stdout.write(await answer(JSON.parse(input) as CliInput));
  } catch (error) {
    process.stdout.write(`Recall failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
