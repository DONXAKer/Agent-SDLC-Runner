import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StageId } from '@sdlc-runner/shared';
import { section } from '../artifacts/preparation.ts';

/** Профиль поставляется с Runner и может читаться из установленного эталона. */
export function preparationInstructions(methodologyDir: string, stage: StageId): string {
  const installed = join(methodologyDir, 'profiles', 'preparation-v2.md');
  const text = readFileSync(existsSync(installed) ? installed : new URL('../../methodology/preparation-v2.md', import.meta.url), 'utf8');
  const name = ['intent', 'explore', 'ask', 'plan'].includes(stage) ? stage : 'implementation';
  const body = section(text, name);
  if (body === '') throw new Error(`профиль проработки v2 не содержит этап ${name}`);
  return text.split('\n## ')[0] + '\n\n' + body;
}
