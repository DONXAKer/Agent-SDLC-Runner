/**
 * Файл результата (часть шага 3 ROADMAP.md).
 *
 * Собирает воедино то, что посчитал рантайм (`run.metrics`, `run.lastVerdict`), то, что
 * прошло через драйвер (`DriverResult`), то, что решил автоответчик (`OperatorDecisionLog`)
 * и то, чего нет в числах рантайма (`CollectorState`). Само по себе ничего не считает —
 * второе место подсчёта здесь так же нежелательно, как и в `operator.ts`/`collector.ts`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { RunMetrics, Verdict } from '@sdlc-runner/shared';

import type { DriverResult } from './driver.ts';
import type { OperatorDecisionLog } from './operator.ts';
import type { CollectorState } from './collector.ts';
import type { BenchOptions } from './options.ts';
import type { BuiltProfile } from './profile.ts';
import type { SeedProbe } from './seeds.ts';

export interface BenchResult {
  /** Идентификация прогона — не измерение, а его паспорт. */
  run: {
    slug: string;
    model: string;
    mode: BenchOptions['mode'];
    profileLabel: string;
    routes: BuiltProfile['routes'];
    /** Валюта каждого маршрута — стоимость этапа подписывается ею, а не хардкодом `$`. */
    currencies: BuiltProfile['currencies'];
    measured: BuiltProfile['measured'];
    startedAt: string;
    finishedAt: string;
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
}): BenchResult {
  const { opts, built } = args;
  return {
    run: {
      slug: opts.slug,
      model: opts.model,
      mode: opts.mode,
      profileLabel: built.profile.label,
      routes: built.routes,
      currencies: built.currencies,
      measured: built.measured,
      startedAt: args.startedAt.toISOString(),
      finishedAt: args.finishedAt.toISOString(),
    },
    driver: args.driver,
    metrics: args.metrics,
    finalVerdict: args.driver.finalVerdict,
    operator: args.operator,
    observed: args.observed,
    seed: args.seed ?? null,
  };
}

/** Пишет `result.json` — каталог создаётся, если его ещё нет (первый прогон бенчмарка). */
export function writeResult(path: string, result: BenchResult): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
}
