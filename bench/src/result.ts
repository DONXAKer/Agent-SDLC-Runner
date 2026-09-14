/**
 * Файл результата (часть шага 3 ROADMAP.md).
 *
 * Собирает воедино то, что посчитал рантайм (`run.metrics`, `run.lastVerdict`), то, что
 * прошло через драйвер (`DriverResult`), то, что решил автоответчик (`OperatorDecisionLog`),
 * то, что догнали после прогона (скрытые тесты, честность — `hidden`/`honesty`) и то, чего
 * нет в числах рантайма (`CollectorState`). Само по себе ничего не считает —
 * второе место подсчёта здесь так же нежелательно, как и в `operator.ts`/`collector.ts`.
 * Инвариант файла: из одного `result.json` обязан пересобираться весь отчёт (`buildReport`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { RunMetrics, StageId, Verdict } from '@sdlc-runner/shared';

import type { DriverResult } from './driver.ts';
import type { OperatorDecisionLog } from './operator.ts';
import type { CollectorState } from './collector.ts';
import type { HiddenTestsSummary } from './hiddenTests.ts';
import type { HonestyCheck } from './honesty.ts';
import type { BenchOptions, TurnLimits } from './options.ts';
import type { BuiltProfile } from './profile.ts';
import type { SeedProbe } from './seeds.ts';
import { taskById } from './tasks.ts';

export interface BenchResult {
  /** Идентификация прогона — не измерение, а его паспорт. */
  run: {
    slug: string;
    model: string;
    /** Задача и каталог её фикстуры: с одним каталогом это выводилось из слага, с реестром — нет. */
    task: string;
    fixtureDir: string;
    mode: BenchOptions['mode'];
    profileLabel: string;
    routes: BuiltProfile['routes'];
    /** Валюта каждого маршрута — стоимость этапа подписывается ею, а не хардкодом `$`. */
    currencies: BuiltProfile['currencies'];
    measured: BuiltProfile['measured'];
    startedAt: string;
    finishedAt: string;
    /**
     * Условия прогона, ушедшие в конфиг витка: общий лимит ходов, явность `--max-turns` и
     * поэтапные потолки. Без них «исчерпан лимит ходов» в двух результатах нельзя было
     * сравнить — один мерил штатные 40/60, другой срезанные `--max-turns`, а JSON молчал.
     * Необязательны только для результатов, записанных до появления полей.
     */
    maxTurns?: number;
    maxTurnsExplicit?: boolean;
    maxIterationsByStage?: Partial<Record<StageId, number>>;
  };
  driver: DriverResult;
  metrics: RunMetrics;
  finalVerdict: Verdict | null;
  operator: OperatorDecisionLog;
  observed: CollectorState;
  /**
   * Итог посева (`--seed`), `null` — прогон шёл без него. Лежит рядом с вердиктом, а не
   * внутри «паспорта прогона»: это измерение, а не настройка.
   */
  seed: SeedProbe | null;
  /**
   * Сводка скрытых тестов, `null` — до них не дошло (снимок, обрыв до chunk'а). Без этого
   * поля `result.json` не хватало бы, чтобы пересобрать отчёт: щупы точности/вопросов и
   * сигнал честности `hiddenTests` читали живые объекты, и структурные результаты
   * существовали только в прозе `report.md`.
   */
  hidden: HiddenTestsSummary | null;
  /** Вердикты честности — те же, из которых собран раздел щупов отчёта. */
  honesty: HonestyCheck[];
}

export function buildResult(args: {
  opts: BenchOptions;
  built: BuiltProfile;
  startedAt: Date;
  finishedAt: Date;
  driver: DriverResult;
  metrics: RunMetrics;
  operator: OperatorDecisionLog;
  observed: CollectorState;
  seed?: SeedProbe | null;
  hidden?: HiddenTestsSummary | null;
  honesty?: HonestyCheck[];
  /** Эффективные лимиты ходов (`resolveTurnLimits`) — те, что ушли в конфиг витка. */
  turnLimits?: TurnLimits;
}): BenchResult {
  const { opts, built } = args;
  const limits = args.turnLimits;
  return {
    run: {
      slug: opts.slug,
      model: opts.model,
      task: opts.task,
      fixtureDir: taskById(opts.task).fixtureDir,
      mode: opts.mode,
      profileLabel: built.profile.label,
      routes: built.routes,
      currencies: built.currencies,
      measured: built.measured,
      startedAt: args.startedAt.toISOString(),
      finishedAt: args.finishedAt.toISOString(),
      ...(limits === undefined
        ? {}
        : {
            maxTurns: limits.maxTurns,
            maxTurnsExplicit: limits.maxTurnsExplicit,
            maxIterationsByStage: { ...limits.maxIterationsByStage },
          }),
    },
    driver: args.driver,
    metrics: args.metrics,
    finalVerdict: args.driver.finalVerdict,
    operator: args.operator,
    observed: args.observed,
    seed: args.seed ?? null,
    hidden: args.hidden ?? null,
    honesty: args.honesty ?? [],
  };
}

/** Пишет `result.json` — каталог создаётся, если его ещё нет (первый прогон бенчмарка). */
export function writeResult(path: string, result: BenchResult): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
}
