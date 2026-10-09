import { createHash } from 'node:crypto';
import { splitRow, isSeparatorRow } from '../md/table.ts';
import { readArtifact } from '../artifacts/artifact.ts';

/** Display documents are parsed by the runtime; models never receive the blank form. */
export function documentFacts(text: string): { section: string; values: unknown[] }[] {
  const result: { section: string; values: unknown[] }[] = [];
  let current = { section: '', values: [] as unknown[] }; result.push(current);
  let headers: string[] = []; let fence: string[] | null = null;
  let comment = false;
  for (const line of text.split(/\r?\n/u)) {
    if (fence === null && (comment || /^\s*<!--/u.test(line))) {
      comment = !line.includes('-->');
      continue;
    }
    if (/^\s*```/u.test(line)) {
      if (fence !== null) { current.values.push({ content: fence.join('\n') }); fence = null; }
      else fence = [];
      continue;
    }
    if (fence !== null) { fence.push(line); continue; }
    if (/^\s*<!--/u.test(line) || !line.trim() || /^\s*---\s*$/u.test(line)) continue;
    const heading = /^#{1,6}\s+(.+)$/u.exec(line);
    if (heading) { current = { section: plainQuestion(heading[1]!), values: [] }; result.push(current); headers = []; continue; }
    if (line.trim().startsWith('|')) {
      if (isSeparatorRow(line)) continue;
      const cells = splitRow(line).map(plainQuestion);
      if (!headers.length) { headers = cells; continue; }
      // Unknown slots are represented explicitly rather than forwarded as form syntax.
      if (cells.some(cell => /‹[^›]*›/u.test(cell))) continue;
      current.values.push(Object.fromEntries(cells.map((cell, i) => [headers[i] ?? String(i), cell])));
      continue;
    }
    if (/‹[^›]*›/u.test(line)) continue;
    if (/^\s*[\[{]/u.test(line)) {
      try { current.values.push(JSON.parse(line)); continue; } catch { /* ordinary document prose */ }
    }
    const value = plainQuestion(line);
    if (value) current.values.push(value);
  }
  if (fence !== null) throw new Error('Незавершённый блок в документе: невозможно обновить структурированные данные');
  return result.filter(section => section.values.length > 0);
}

export function decisionData(context: string | undefined): unknown {
  if (!context) return null;
  try { return JSON.parse(context); } catch { return context; }
}

/** This only processes runtime questions/documents, never source code or original requests. */
export function plainQuestion(text: string): string {
  return text.replace(/^\s*#{1,6}\s+/gmu, '').replace(/^\s*[-*+]\s+/gmu, '')
    .replace(/\*\*([^*]+)\*\*/gu, '$1').replace(/`([^`]+)`/gu, '$1').replace(/‹([^›]*)›/gu, '$1').trim();
}

export function artifactFacts(path: string) {
  const artifact = readArtifact(path);
  return { path, hash: createHash('sha256').update(artifact.text).digest('hex'), exists: artifact.exists,
    sections: documentFacts(artifact.text) };
}

export interface GuidedQuestion {
  version: 1;
  questionId: string;
  question: string;
  data: unknown;
}

export function guidedQuestion(id: string, question: string, data: unknown): string {
  return JSON.stringify({ version: 1, questionId: id, question: plainQuestion(question), data } satisfies GuidedQuestion);
}

export function appendGuidedData(user: string, name: string, value: unknown): string {
  const parsed: unknown = JSON.parse(user);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Повреждён вход guided');
  return JSON.stringify({ ...parsed, [name]: value });
}
