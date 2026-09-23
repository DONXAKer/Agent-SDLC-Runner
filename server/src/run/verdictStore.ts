/**
 * Вердикт попытки на диске — служебный файл рантайма `.chunk-N-attempt-K-verdict.json`.
 *
 * Единственный источник «принята ли попытка» для handoff (коммит!), предусловия chunk,
 * `/advance` и восстановления после рестарта. Прежде этим источником была строка
 * `passed:` отчёта приёмки — а отчёт пишет и модель этапа 6: `- passed: true`, записанный
 * моделью до отмены этапа (хук вердикта не дошёл), открывал handoff с коммитом
 * непроверенного витка (code-review-all 2026-09-23). Дот-файл каталога витка модели на
 * запись закрыт политикой (`planScope::isRuntimeServiceFile`); секция «Вердикт» отчёта
 * остаётся копией для человека и терминальных скиллов, решений по ней рантайм не принимает.
 *
 * Нет файла — нет вердикта: и для витка, начатого до этого файла, и для verify,
 * оборванного до расчёта. Путь «прочитать по старинке из отчёта» намеренно не оставлен:
 * он и был дырой.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import type { Verdict, VerdictAction } from '@sdlc-runner/shared';

import type { WitokPaths } from '../artifacts/paths.ts';

const ACTIONS: readonly VerdictAction[] = ['continue', 'retry', 'escalate', 'blocked_env'];

export function writeRunVerdict(paths: WitokPaths, chunk: number, attempt: number, verdict: Verdict): void {
  const body = { chunk, attempt, passed: verdict.passed, action: verdict.action, reasons: verdict.reasons };
  writeFileSync(paths.verdictFile(chunk, attempt), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

/** Вердикт попытки или `null` — файла нет либо он не разбирается (битый — не вердикт). */
export function readRunVerdict(paths: WitokPaths, chunk: number, attempt: number): Verdict | null {
  const p = paths.verdictFile(chunk, attempt);
  if (!existsSync(p)) return null;
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    if (typeof v['passed'] !== 'boolean') return null;
    const action = ACTIONS.find((a) => a === v['action']);
    if (action === undefined) return null;
    const reasons = Array.isArray(v['reasons']) ? v['reasons'].filter((r): r is string => typeof r === 'string') : [];
    return { passed: v['passed'], action, reasons };
  } catch {
    return null;
  }
}

/**
 * Снимает вердикт попытки на входе в verify: повторная проверка той же попытки, оборванная
 * до расчёта, не должна оставить в силе вердикт прошлого прогона.
 */
export function clearRunVerdict(paths: WitokPaths, chunk: number, attempt: number): void {
  rmSync(paths.verdictFile(chunk, attempt), { force: true });
}
