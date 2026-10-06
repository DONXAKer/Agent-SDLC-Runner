import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Verdict } from '@sdlc-runner/shared';
import type { WitokPaths } from '../artifacts/paths.ts';
import { gateKey, type GatesFile } from '../gates/gatesFile.ts';
import { verdictPath } from './verdictStore.ts';

const DEFAULT_BUDGET = 3;

/** Настройка рядом с «Бюджет итераций»: включённая строка, целое число 1–20. */
export function envRetryBudget(gates: GatesFile | null): number {
  const row = gates?.rows.find(r => gateKey(r.name) === gateKey('Бюджет средовых повторов'));
  if (!row?.enabled) return DEFAULT_BUDGET;
  const value = row.implementation.trim().replace(/^`(.*)`$/u, '$1');
  if (!/^\d+$/u.test(value)) return DEFAULT_BUDGET;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 20) : DEFAULT_BUDGET;
}

interface EnvRetryState {
  version: 1;
  chunk: number;
  cycle: string;
  /** Счёт ДО текущего прогона: повторный расчёт заменяет результат прогона. */
  before: number;
  count: number;
}

export function envRetryStatePath(paths: WitokPaths, chunk: number): string {
  return join(dirname(verdictPath(paths, chunk, 1)), `chunk-${chunk}-env-retries.json`);
}

function readState(paths: WitokPaths, chunk: number): EnvRetryState | null {
  const file = envRetryStatePath(paths, chunk);
  if (!existsSync(file)) return null;
  let value: Partial<EnvRetryState> | null;
  try { value = JSON.parse(readFileSync(file, 'utf8')) as Partial<EnvRetryState> | null; }
  catch { throw new Error(`Состояние средовых повторов повреждено: ${file}; восстанови файл перед Verify`); }
  if (value?.version !== 1 || value.chunk !== chunk || typeof value.cycle !== 'string' ||
      !Number.isSafeInteger(value.before) || value.before! < 0 ||
      !Number.isSafeInteger(value.count) || value.count! < 0) {
    throw new Error(`Состояние средовых повторов некорректно: ${file}; восстанови файл перед Verify`);
  }
  return value as EnvRetryState;
}

export function envRetryCount(paths: WitokPaths, chunk: number): number {
  return readState(paths, chunk)?.count ?? 0;
}

/** Защищённое состояние рантайма, отдельное от доступных модели артефактов. */
export function applyEnvRetryBudget(
  paths: WitokPaths, chunk: number, cycle: string, verdict: Verdict, budget: number,
): Verdict {
  const previous = readState(paths, chunk);
  const before = previous?.cycle === cycle ? previous.before : previous?.count ?? 0;
  const blocked = !verdict.passed && verdict.action === 'blocked_env';
  const count = blocked ? before + 1 : 0;
  // У обычных витков без средовых красных дополнительного файла нет.
  if (blocked || previous !== null) {
    const state: EnvRetryState = { version: 1, chunk, cycle, before, count };
    if (JSON.stringify(previous) !== JSON.stringify(state)) {
      const file = envRetryStatePath(paths, chunk);
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        renameSync(temporary, file);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
  }
  if (!blocked) return verdict;
  const exhausted = count >= budget;
  return {
    ...verdict,
    action: exhausted ? 'escalate' : 'blocked_env',
    reasons: [...verdict.reasons, exhausted
      ? `среда не восстановлена за ${count} прогонов Verify подряд (бюджет средовых повторов ${budget}); восстанови среду и повтори Verify либо оформи обрыв витка`
      : `средовой красный ${count} из ${budget} подряд; восстанови среду и повтори Verify, номер попытки сохраняется`],
  };
}
