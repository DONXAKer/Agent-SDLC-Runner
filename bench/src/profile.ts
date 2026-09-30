/**
 * Маршруты прогона: что идёт по контролю, что под измерением.
 *
 * Все этапы полного цикла используют выбранную модель, если оператор явно не заменил маршрут.
 */

import { readFileSync } from 'node:fs';

import { STAGE_ORDER } from '@sdlc-runner/shared';
import type { StageId } from '@sdlc-runner/shared';

import type { ModelsConfig, ProjectConfig, ResolvedProfile } from '../../server/src/config/schema.ts';
import { resolveAdHocProfile } from '../../server/src/config/profiles.ts';
import type { BenchMode, BenchOptions } from './options.ts';

export interface ControlFile {
  label: string;
  stages: Record<StageId, string>;
}

export class ControlError extends Error {}

export function readControl(path: string): ControlFile {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new ControlError(`${path}: ожидался объект`);
  const o = raw as { label?: unknown; stages?: unknown };
  if (typeof o.label !== 'string') throw new ControlError(`${path}: нет поля label`);
  if (typeof o.stages !== 'object' || o.stages === null) throw new ControlError(`${path}: нет поля stages`);

  const stages = o.stages as Record<string, unknown>;
  const out: Partial<Record<StageId, string>> = {};
  for (const stage of STAGE_ORDER) {
    const v = stages[stage];
    // Пропущенный этап — это не «возьмём умолчание»: контрольный маршрут обязан быть
    // назван целиком, иначе сравнение с прошлым прогоном опирается на невидимое.
    if (typeof v !== 'string' || v === '') throw new ControlError(`${path}: не задана модель этапа «${stage}»`);
    out[stage] = v;
  }
  return { label: o.label, stages: out as Record<StageId, string> };
}

/** Этапы, которые в этом режиме идут под измеряемой моделью. */
export function measuredStages(mode: BenchMode): readonly StageId[] {
  if (mode.kind === 'stage') return [mode.stage];
  return STAGE_ORDER;
}

export interface BuiltProfile {
  project: ProjectConfig;
  profile: ResolvedProfile;
  measured: readonly StageId[];
  /** Итоговая раскладка «этап → модель» — она же уходит в отчёт. */
  routes: Record<StageId, string>;
  /**
   * Валюта каждого маршрута (`ProviderDef.currency`, умолчание USD) — для честной
   * подписи стоимости: polza считает в рублях, и хардкод `$` в отчёте завышал трату
   * в глазах оператора ~в 90 раз (тот же класс, против которого в shared есть `money`).
   */
  currencies: Record<StageId, string>;
}

export function buildProfile(args: {
  projectRoot: string;
  models: ModelsConfig;
  control: ControlFile;
  opts: BenchOptions;
}): BuiltProfile {
  const { control, opts } = args;
  const measured = opts.dryRun && opts.model === '' ? [] : measuredStages(opts.mode).filter((stage) =>
    opts.mode.kind === 'stage' || opts.controlOverrides[stage] === undefined || opts.controlOverrides[stage] === opts.model,
  );

  const routes: Record<string, string> = { ...control.stages, ...opts.controlOverrides };
  for (const stage of measured) routes[stage] = opts.model;
  const allLocal = Object.values(routes).every((id) => {
    const model = args.models.models.find((entry) => entry.id === id);
    return model !== undefined && ['ollama', 'lmstudio'].includes(model.provider);
  });

  const project: ProjectConfig = {
    name: 'bench',
    projectRoot: args.projectRoot,
    activeProfile: 'control',
    // На локальных маршрутах costUsd приходит null, и бюджет не действует вообще —
    // ограничителями остаются ходы и стенные часы. Здесь это только верхняя планка.
    maxBudgetUsd: opts.maxBudgetUsd,
    profiles: {
      control: { label: allLocal ? 'Локальные маршруты Ollama / LM Studio' : control.label, stages: control.stages },
    },
  };

  const profile = resolveAdHocProfile(project, args.models, routes, 'control');
  const currencies = Object.fromEntries(
    Object.entries(profile.routes).map(([stage, r]) => [stage, r.providerDef.currency ?? 'USD']),
  ) as Record<StageId, string>;
  return { project, profile, measured, routes: routes as Record<StageId, string>, currencies };
}
