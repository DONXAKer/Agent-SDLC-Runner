/** Evidence for stage experiments. Observations never infer semantic correctness. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { placeholderRanges } from '../../server/src/artifacts/artifact.ts';

export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function treeDigest(root: string): string {
  const hash = createHash('sha256');
  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (['.git', 'node_modules'].includes(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        hash.update(relative(root, path).replaceAll('\\', '/')).update('\0');
        hash.update(digest(readFileSync(path))).update('\0');
      }
    }
  }
  visit(root);
  return hash.digest('hex');
}

export interface DiagnosticPassport {
  version: 1;
  gitHead: string | null;
  sourceHash: string;
  configHash: string;
  inputHash: string;
  snapshotAuthor: string | null;
  snapshotName: string | null;
  stageTimeoutMs: number;
  runTimeoutMs: number;
  localEndpoints?: Record<string, string>;
}

export function passport(args: {
  repo: string; input: string; config: unknown; snapshotName: string | null;
  stageTimeoutMs: number; runTimeoutMs: number; promptRoots?: readonly string[];
}): DiagnosticPassport {
  let gitHead: string | null = null;
  try { gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: args.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* non-git distribution */ }
  const sourceHash = digest(['server/src', 'shared/src', 'bench/src', '.claude', ...(args.promptRoots ?? [])].map((dir) => {
    const path = isAbsolute(dir) ? dir : join(args.repo, dir);
    return existsSync(path) ? `${dir}:${treeDigest(path)}` : `${dir}:absent`;
  }).join('\n'));
  const localEndpoints: Record<string, string> = {};
  for (const provider of ['OLLAMA', 'LMSTUDIO']) {
    const value = process.env[`${provider}_BASE_URL`]?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      localEndpoints[provider.toLowerCase()] = url.toString();
    } catch { localEndpoints[provider.toLowerCase()] = 'invalid-url'; }
  }
  const metaPath = join(args.input, 'snapshot.json');
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) as { authorModel?: string } : null;
  let snapshotAuthor = meta?.authorModel ?? null;
  // Older snapshots predate snapshot.json.authorModel; recover only an explicit executor field.
  if (snapshotAuthor === null) {
    const evidenceAuthors = new Set<string>();
    const scan = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (entry.isFile() && /(?:evidence.*|.*-evidence)\.json$/i.test(entry.name)) {
          try {
            const evidence = JSON.parse(readFileSync(path, 'utf8')) as { executor_model?: unknown };
            if (typeof evidence.executor_model === 'string' && evidence.executor_model !== '') evidenceAuthors.add(evidence.executor_model);
          } catch { /* malformed evidence cannot establish provenance */ }
        }
      }
    };
    scan(join(args.input, '.sdlc'));
    if (evidenceAuthors.size === 1) snapshotAuthor = [...evidenceAuthors][0]!;
  }
  return {
    version: 1, gitHead, sourceHash, configHash: digest(JSON.stringify({ config: args.config, localEndpoints })),
    localEndpoints,
    inputHash: treeDigest(args.input), snapshotName: args.snapshotName,
    snapshotAuthor,
    stageTimeoutMs: args.stageTimeoutMs, runTimeoutMs: args.runTimeoutMs,
  };
}

export interface ArtifactObservation {
  path: string;
  sha256: string;
  placeholders: number;
  uncheckedQuestions: number;
  blockingQuestions: number;
}

function questionCounts(content: string): { unchecked: number; blocking: number } {
  const lines = content.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^#{2,3}\s+Открытые вопросы\s*$/iu.test(line.trim()));
  if (heading < 0) return { unchecked: 0, blocking: 0 };
  let end = lines.length;
  for (let i = heading + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i]!.trim())) { end = i; break; }
  }
  const rows = lines.slice(heading + 1, end).filter((line) => /^\s*[-*+]\s*\[\s\]\s*/u.test(line));
  return { unchecked: rows.length, blocking: rows.filter((line) => /\[блокирующий\]/iu.test(line)).length };
}
export function observeArtifacts(root: string): ArtifactObservation[] {
  const observations: ArtifactObservation[] = [];
  if (!existsSync(root)) return observations;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const content = readFileSync(path, 'utf8');
        const questions = questionCounts(content);
        observations.push({
          path: relative(root, path).replaceAll('\\', '/'), sha256: digest(content),
          placeholders: placeholderRanges(content).length,
          uncheckedQuestions: questions.unchecked, blockingQuestions: questions.blocking,
        });
      }
    }
  };
  visit(root);
  return observations.sort((a, b) => a.path.localeCompare(b.path));
}

export interface RunDiagnostics {
  passport: DiagnosticPassport;
  /** Project tree at this checkpoint, excluding .git and node_modules. */
  workspaceHash?: string;
  state: 'running' | 'finished' | 'cancelled' | 'exception';
  capturedAt: string;
  lastEvent: { type: string; stage: string | null; at: string } | null;
  artifacts: ArtifactObservation[];
  /** A reviewer/checklist must supply this; placeholders are not a quality oracle. */
  semanticAssessment: 'not-assessed';
}
