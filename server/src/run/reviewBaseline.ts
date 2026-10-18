import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { splitHunks } from './claimEvidence.ts';

/** Только совпадение с сохранённым хешем подтверждает, что файл не менялся в попытке. */
export function reviewBaselineContext(root: string, diff: string, baseline: ReadonlyMap<string, string> | null): string {
  if (!baseline) return '';
  const unchanged = [...new Set(splitHunks(diff).map((h) => h.file))].filter((file) => {
    const hash = baseline.get(file);
    const path = resolve(root, file);
    if (!hash || !path.startsWith(resolve(root) + sep)) return false;
    try { return createHash('sha256').update(readFileSync(path)).digest('hex') === hash; }
    catch { return false; }
  });
  if (!unchanged.length) return '';
  return ['## Проверенная база попытки',
    'Следующие файлы уже отличались от HEAD до начала chunk и с тех пор не изменились (SHA-256 совпадает):',
    ...unchanged.map((file) => `- ${file}`),
    'Их diff сохранён для контекста. Эти изменения не внесены текущей задачей и сами по себе не доказывают нарушения её scope или осей плана.',
    'Проверяй взаимодействие нового кода с ними; конкретный дефект всё равно нужно назвать с доказательствами.',
  ].join('\n');
}
