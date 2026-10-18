import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { guardedPath } from '../server/src/exec/GuidedExecutor.ts';

/** Validate the whole proposal before writes; restore earlier writes on an I/O failure. */
export function applyPilotFiles(root: string, required: readonly string[], answer: unknown): void {
  if (!answer || typeof answer !== 'object' || !('files' in answer) || !Array.isArray(answer.files)) throw new Error('Expected files array');
  const seen = new Set<string>();
  const files = answer.files.map((file: unknown) => {
    if (!file || typeof file !== 'object' || !('path' in file) || !('content' in file) ||
        typeof file.path !== 'string' || typeof file.content !== 'string' || !required.includes(file.path) || seen.has(file.path)) throw new Error('Invalid or duplicate file entry');
    seen.add(file.path);
    const path = guardedPath(root, file.path);
    return { path, content: file.content, before: existsSync(path) ? readFileSync(path) : null, temporary: `${path}.${randomUUID()}.tmp` };
  });
  if (required.some(path => !seen.has(path))) throw new Error('Response omitted a required file');
  const applied: typeof files = [];
  try {
    for (const file of files) { mkdirSync(dirname(file.path), { recursive: true }); writeFileSync(file.temporary, file.content, 'utf8'); }
    for (const file of files) { renameSync(file.temporary, file.path); applied.push(file); }
  } catch (error) {
    for (const file of applied.reverse()) {
      if (file.before === null) unlinkSync(file.path); else writeFileSync(file.path, file.before);
    }
    throw error;
  } finally {
    for (const file of files) if (existsSync(file.temporary)) unlinkSync(file.temporary);
  }
}
