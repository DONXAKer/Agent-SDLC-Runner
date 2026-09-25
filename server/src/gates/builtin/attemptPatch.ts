/**
 * Патч попытки как вход встроенного гейта: записанный рантаймом файл
 * (`chunk-N-attempt-K-diff.patch`, `GateContext.attemptPatchPath`), а без него —
 * перегенерация тем же `attemptDiff` от той же базы. Один разбор на прогон: кэш по
 * идентичности контекста, как у `diffCache` гейтов анти-обхода.
 */

import { existsSync, readFileSync } from 'node:fs';

import { attemptDiff } from '../git.ts';
import type { GateContext } from './index.ts';

const cache = new WeakMap<GateContext, Promise<string>>();

export function attemptPatchOf(ctx: GateContext): Promise<string> {
  let p = cache.get(ctx);
  if (p === undefined) {
    p = (async () => {
      if (ctx.attemptPatchPath !== undefined && existsSync(ctx.attemptPatchPath)) {
        return readFileSync(ctx.attemptPatchPath, 'utf8');
      }
      return attemptDiff(ctx.projectRoot, { baseSha: ctx.baseSha ?? null, signal: ctx.signal });
    })();
    cache.set(ctx, p);
  }
  return p;
}
