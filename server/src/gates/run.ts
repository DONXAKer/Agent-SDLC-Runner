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
import { basename } from 'node:path';

import type { GateRunResult, GateStatus } from '@sdlc-runner/shared';

import type { GateContext } from './builtin/index.ts';
import { builtinFor } from './builtin/index.ts';
import type { GateRow, GatesFile } from './gatesFile.ts';
import { gateKey, gatesRunnableAtVerify, parseGates } from './gatesFile.ts';
import { runShell } from './shell.ts';
import { ensureSandboxFor } from '../sandbox/registry.ts';

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

async function runOne(row: GateRow, i: RunGatesInput, ctx: GateContext): Promise<GateRunResult> {
  const started = Date.now();

  // Сопоставление по ключу, а не по точному имени: оператор пишет строку набора как
  // человек, а совпадать она обязана с тем же ключом, по которому её ищет диспетчеризация.
  const external = i.externalStatuses?.[gateKey(row.name)];
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

  const outcome = await builtin(ctx);
  return { name: row.name, ...outcome, durationMs: Date.now() - started };
}

/**
 * Гейты идут последовательно, а не параллельно: они делят рабочее дерево и git-индекс,
 * а сборка и тесты ещё и конкурируют за память. Выигрыш от параллельности здесь мнимый,
 * а взаимные помехи — настоящие.
 */
export async function runGates(i: RunGatesInput): Promise<GateRunResult[]> {
  // Готовим песочницу проекта ДО первого гейта — если у проекта есть `.sdlc/sandbox.json`,
  // «Сборка»/«Тесты» пойдут внутрь неё прозрачно через `runShell` (см. `sandbox/registry.ts`).
  // Нет спеки — `ensureSandboxFor` возвращает `null`, и всё идёт локальным путём, как раньше.
  // Сбой сборки образа НЕ роняет виток целиком: гейты просто останутся на локальном
  // исполнителе и упадут своей обычной красной строкой («java: not found» и т.п.) — это то
  // же самое состояние, что было до появления песочницы, а не новый класс отказа.
  try {
    await ensureSandboxFor(i.projectRoot, basename(i.projectRoot));
  } catch (e) {
    console.error(`[sandbox] песочница ${i.projectRoot} не поднялась: ${(e as Error).message}`);
  }

  // Контекст один на прогон и общий для всех гейтов: по нему кэшируется разбор diff'а
  // (`diffViolations`), который иначе тянут по разу «Анти-обход» и «Секреты». Пересоздание
  // контекста на каждый гейт обнуляло бы кэш, а модульный кэш по корню проекта пережил бы
  // прогон и отдал бы второй попытке находки первой.
  const ctx: GateContext = {
    projectRoot: i.projectRoot,
    planFiles: i.planFiles,
    baseline: i.baseline,
    timeoutMs: i.timeoutMs,
    ...(i.modules === undefined ? {} : { modules: i.modules }),
    ...(i.signal === undefined ? {} : { signal: i.signal }),
  };

  const out: GateRunResult[] = [];
  for (const row of gatesRunnableAtVerify(i.gates)) {
    if (i.signal?.aborted === true) break;
    const r = await runOne(row, i, ctx);
    out.push(r);
    i.onResult?.(r);
  }
  return out;
}
