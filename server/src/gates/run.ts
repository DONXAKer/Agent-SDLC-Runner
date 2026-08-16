/**
 * Прогон гейтов этапа 6.
 *
 * Порядок из методологии: **автоматические гейты идут перед ревью**, а не держатся на
 * промпте рецензента. Поэтому это отдельный шаг рантайма, а не инструмент, который
 * модель может забыть вызвать.
 *
 * Каждому включённому гейту «этап 6» соответствует ровно одна строка результата с именем
 * **дословно как в наборе** — сверка отчёта с набором идёт по именам, и склейка двух
 * гейтов в один лишила бы один из них статуса.
 */

import { readFileSync } from 'node:fs';

import type { GateRunResult, GateStatus } from '@sdlc-runner/shared';

import type { GateContext } from './builtin/index.ts';
import { builtinFor } from './builtin/index.ts';
import type { GateRow, GatesFile } from './gatesFile.ts';
import { gatesRunnableAtVerify, parseGates } from './gatesFile.ts';
import { runShell } from './shell.ts';

export function loadGates(gatesPath: string): GatesFile {
  return parseGates(readFileSync(gatesPath, 'utf8'));
}

export interface RunGatesInput extends GateContext {
  gates: GatesFile;
  /**
   * Статусы гейтов, которые рантайм не исполняет сам: ревью независимым агентом даёт
   * статус прогоном субагента, ранние этапы — переносом со своего этапа. Ключ — имя
   * строки набора.
   */
  externalStatuses?: Readonly<Record<string, GateStatus>>;
  onResult?: (r: GateRunResult) => void;
}

async function runOne(row: GateRow, i: RunGatesInput): Promise<GateRunResult> {
  const started = Date.now();

  const external = i.externalStatuses?.[row.name];
  if (external !== undefined) {
    return {
      name: row.name,
      status: external,
      command: null,
      exitCode: null,
      lastLine: `статус получен не скриптом: ${row.implementation || 'источник не назван'}`,
      durationMs: 0,
    };
  }

  // Команда набора имеет приоритет над встроенной: проект, назвавший свою команду,
  // знает про себя больше, чем детект.
  if (row.command !== null) {
    const r = await runShell(row.command, {
      cwd: i.projectRoot,
      timeoutMs: i.timeoutMs,
      ...(i.signal === undefined ? {} : { signal: i.signal }),
    });
    const status: GateStatus =
      r.denied !== null || r.timedOut ? '⏭' : r.exitCode === 0 ? '✅' : '❌';
    return {
      name: row.name,
      status,
      command: row.command,
      exitCode: r.exitCode,
      lastLine: r.timedOut ? `команда не уложилась в ${i.timeoutMs} мс` : r.lastLine,
      durationMs: r.durationMs,
    };
  }

  const builtin = builtinFor(row.name);
  if (builtin === null) {
    // Гейт включён, а исполнителя у него нет. Это `⏭`, и он уронит вердикт, если человек
    // не подпишет неприменимость — ровно тот случай, ради которого статус и заведён.
    return {
      name: row.name,
      status: '⏭',
      command: null,
      exitCode: null,
      lastLine:
        `гейт включён, но исполнить его нечем: в наборе нет команды в обратных кавычках, ` +
        `встроенной реализации под это имя тоже нет`,
      durationMs: 0,
    };
  }

  const outcome = await builtin({
    projectRoot: i.projectRoot,
    planFiles: i.planFiles,
    baseline: i.baseline,
    timeoutMs: i.timeoutMs,
    ...(i.signal === undefined ? {} : { signal: i.signal }),
  });
  return { name: row.name, ...outcome, durationMs: Date.now() - started };
}

/**
 * Гейты идут последовательно, а не параллельно: они делят рабочее дерево и git-индекс,
 * а сборка и тесты ещё и конкурируют за память. Выигрыш от параллельности здесь мнимый,
 * а взаимные помехи — настоящие.
 */
export async function runGates(i: RunGatesInput): Promise<GateRunResult[]> {
  const out: GateRunResult[] = [];
  for (const row of gatesRunnableAtVerify(i.gates)) {
    if (i.signal?.aborted === true) break;
    const r = await runOne(row, i);
    out.push(r);
    i.onResult?.(r);
  }
  return out;
}
