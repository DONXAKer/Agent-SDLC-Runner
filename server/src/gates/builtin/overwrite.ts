/**
 * Гейт «Перезапись файла» (`SDLC.md` → «Стереть файл — не то же самое, что записать в
 * него»): файл, потерявший в diff'е не меньше половины строк базы или удалённый целиком,
 * обязан иметь в журнале chunk'а строку подтверждения с именем человека — без неё гейт
 * красный. Порог 50 % — число из измерения (1235 строк → 11-строчная заглушка при всех
 * зелёных проверках), не из вкуса.
 *
 * Счёт — по файлам патча попытки (`diffstat.per_file`): потерянные строки против длины
 * файла на базе (`git show <base>:<путь>`). Подтверждение — секция «## Перезапись файлов»
 * журнала chunk'а, строка на файл: `путь — почему перезапись законна — подтвердил имя · дата`.
 */

import { existsSync, readFileSync } from 'node:fs';

import { overwriteConfirmations } from '../../artifacts/overwriteConfirmations.ts';
import { SDLC_CONSTANTS } from '../../config/constants.ts';
import { patchFiles } from '../../diff/diffstat.ts';
import { git, hasCommits, isRepo } from '../git.ts';
import { attemptPatchOf } from './attemptPatch.ts';
import type { BuiltinGate, BuiltinOutcome } from './index.ts';

/** Порог доли потерянных строк базы, с которого перезапись требует решения человека — `sdlc-constants.json`. */
export const OVERWRITE_THRESHOLD_PERCENT: number = SDLC_CONSTANTS.overwrite_threshold_percent;

// Разбор строк подтверждения — в `artifacts/overwriteConfirmations.ts`: его делит гард
// фабрикации подписи (`approval/humanDecision.ts`). Реэкспорт — ради прежних вызывающих.
export { overwriteConfirmations } from '../../artifacts/overwriteConfirmations.ts';
export type { OverwriteConfirmation } from '../../artifacts/overwriteConfirmations.ts';

async function baseLineCount(root: string, ref: string, path: string, signal?: AbortSignal): Promise<number | null> {
  const r = await git(['show', `${ref}:${path}`], root, signal);
  if (r.code !== 0) return null;
  const text = r.stdout;
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

export const overwriteGate: BuiltinGate = async (ctx): Promise<BuiltinOutcome> => {
  if (!(await isRepo(ctx.projectRoot)) || !(await hasCommits(ctx.projectRoot))) {
    return { status: '⏭', command: null, exitCode: null, lastLine: 'не git-репозиторий или нет коммитов — длину файлов на базе взять неоткуда' };
  }
  let patch: string;
  try {
    patch = await attemptPatchOf(ctx);
  } catch (e) {
    // Отказ снятия патча — не среда и не провал гейта: исполнить нечем, причина названа.
    return { status: '⏭', command: null, exitCode: null, lastLine: `патч попытки не снят: ${(e as Error).message}` };
  }
  const ref = ctx.baseSha ?? 'HEAD';
  const candidates: { path: string; note: string }[] = [];
  for (const f of patchFiles(patch)) {
    if (f.new) continue;
    if (f.deleted) {
      candidates.push({ path: f.path, note: `${f.path} — удалён целиком` });
      continue;
    }
    const base = await baseLineCount(ctx.projectRoot, ref, f.path, ctx.signal);
    if (base === null || base === 0) continue;
    const percent = Math.floor((f.removed * 100) / base);
    if (percent >= OVERWRITE_THRESHOLD_PERCENT) {
      candidates.push({ path: f.path, note: `${f.path} — потеряно ${f.removed} из ${base} строк базы (${percent} %)` });
    }
  }
  if (candidates.length === 0) {
    return {
      status: '✅',
      command: null,
      exitCode: 0,
      lastLine: `ни один файл не теряет ${OVERWRITE_THRESHOLD_PERCENT} % строк базы и не удаляется целиком`,
    };
  }
  const journal = ctx.journalPath !== undefined && existsSync(ctx.journalPath) ? readFileSync(ctx.journalPath, 'utf8') : '';
  const confirmed = overwriteConfirmations(journal);
  const missing = candidates.filter((c) => !confirmed.some((k) => k.path === c.path.replace(/\\/g, '/')));
  if (missing.length === 0) {
    return {
      status: '✅',
      command: null,
      exitCode: 0,
      lastLine: `перезаписи подтверждены в журнале chunk'а: ${candidates.map((c) => c.path).join(', ')}`,
      evidence: candidates.map((c) => c.note),
    };
  }
  return {
    status: '❌',
    command: null,
    exitCode: 1,
    lastLine:
      `перезапись без подтверждения человека (${missing.length}): ${missing.map((c) => c.note).join('; ')}. ` +
      'Нужна строка в секции «## Перезапись файлов» журнала chunk\'а: `путь — почему — подтвердил имя · дата`',
    evidence: missing.map((c) => c.note),
  };
};
