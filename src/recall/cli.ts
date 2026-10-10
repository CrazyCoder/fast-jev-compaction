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
import { runRecall, type RecallRequest } from './recall.ts';
import { isSavedOutput } from './tool.ts';
import { transcriptReader } from './transcript.ts';

export type CliInput = { configDir: string; sessionId: string; request: RecallRequest };

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
  const reader = transcriptReader();
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) reader.line(line);
  return runRecall(reader.entries, request, {
    readFile: (path) => {
      if (!isSavedOutput(path, configDir)) return undefined;
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
  });
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
