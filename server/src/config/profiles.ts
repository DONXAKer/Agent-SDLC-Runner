/**
 * Профили и правило рецензента.
 *
 * Профиль переводит весь виток целиком: `claude` — всё по Max-подписке, `local` — всё
 * локально и бесплатно. Внутри профиля модель настраивается на каждом этапе. Флоу
 * исполнения выводится из провайдера, отдельной настройки для него нет.
 */

import { STAGE_ORDER, type StageId } from '@sdlc-runner/shared';
import type { ModelsConfig, ProjectConfig, ResolvedProfile, ResolvedRoute } from './schema.ts';

export class ProfileError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(problems.join('\n'));
    this.name = 'ProfileError';
    this.problems = problems;
  }
}

/**
 * Форма добора осей плана из `ModelDef.planAxisFill`. `true` — комбинированный добор, как
 * до появления пошагового: под этим значением записи `config/models.json` замерены
 * (test29), и тихая смена смысла `true` сравнивала бы в матрице два механизма под одним
 * id. Неизвестное значение — проблема профиля, а не молчаливое включение пошагового режима
 * опечаткой (`'combned'`, `"false"`) (code-review-all 2026-09-23).
 */
function planAxisFillMode(
  value: unknown,
  stage: StageId,
  modelId: string,
  problems: string[],
): false | 'combined' | 'stepwise' {
  if (value === undefined || value === false) return false;
  if (value === true || value === 'combined') return 'combined';
  if (value === 'stepwise') return 'stepwise';
  problems.push(
    `этап «${stage}»: у модели «${modelId}» planAxisFill = ${JSON.stringify(value)} — ` +
      'допустимо true/false, "combined" или "stepwise"',
  );
  return false;
}

function resolveRoute(
  stage: StageId,
  modelId: string,
  models: ModelsConfig,
  problems: string[],
): ResolvedRoute | null {
  const def = models.models.find((m) => m.id === modelId);
  if (def === undefined) {
    problems.push(`этап «${stage}»: модель «${modelId}» не найдена в config/models.json`);
    return null;
  }
  const providerDef = models.providers[def.provider];
  if (providerDef === undefined) {
    problems.push(
      `этап «${stage}»: провайдер «${def.provider}» модели «${modelId}» не описан в config/models.json`,
    );
    return null;
  }
  return {
    stage,
    modelId,
    provider: def.provider,
    providerDef,
    model: def.model,
    flow: providerDef.flow,
    rank: def.rank,
    params: def.params ?? null,
    leanTools: def.leanTools ?? false,
    formFill: def.formFill ?? false,
    claimFill: def.claimFill ?? false,
    reviewFill: def.reviewFill ?? false,
    skipTurnAfterReviewFill: def.skipTurnAfterReviewFill ?? false,
    planAxisFill: planAxisFillMode(def.planAxisFill, stage, modelId, problems),
    stepFill: def.stepFill ?? false,
    // Step context is part of the default stepFill workflow; opt out for controlled comparisons.
    stepContext: def.stepContext ?? (def.stepFill ?? false),
    compactForms: def.compactForms ?? 'off',
    ...(def.contextWindow === undefined ? {} : { contextWindow: def.contextWindow }),
    ...(def.historyBudgetBytes === undefined ? {} : { historyBudgetBytes: def.historyBudgetBytes }),
    exploreIndex: def.exploreIndex ?? false,
    exploreFill: def.exploreFill ?? false,
  };
}

/**
 * Разрешает профиль в маршруты по этапам. Проблемы копятся все сразу, а не по первой:
 * оператору полезнее увидеть весь список, чем чинить конфиг по одной строке за прогон.
 */
export function resolveProfile(
  project: ProjectConfig,
  models: ModelsConfig,
  profileName: string,
): ResolvedProfile {
  const problems: string[] = [];
  const profile = project.profiles[profileName];

  if (profile === undefined) {
    const known = Object.keys(project.profiles).join(', ');
    throw new ProfileError([
      `профиль «${profileName}» не описан в проекте «${project.name}». Известные: ${known}`,
    ]);
  }

  const routes: Partial<Record<StageId, ResolvedRoute>> = {};
  const ensemble: Partial<Record<StageId, ResolvedRoute[]>> = {};

  for (const stage of STAGE_ORDER) {
    const raw = profile.stages[stage];
    // Строка = список из одного: форма конфига остаётся обратно совместимой.
    const ids = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const nonEmpty = ids.filter((v) => typeof v === 'string' && v !== '');

    if (nonEmpty.length === 0) {
      problems.push(`этап «${stage}» не назначен ни на одну модель в профиле «${profileName}»`);
      continue;
    }

    const resolved = nonEmpty
      .map((id) => resolveRoute(stage, id, models, problems))
      .filter((r): r is ResolvedRoute => r !== null);
    if (resolved.length === 0) continue;

    ensemble[stage] = resolved;
    // Первый маршрут — основной: он определяет исполнителя и попадает в `stage_started`.
    routes[stage] = resolved[0]!;
  }

  if (problems.length > 0) throw new ProfileError(problems);

  return {
    name: profileName,
    label: profile.label,
    routes: routes as Record<StageId, ResolvedRoute>,
    ensemble: ensemble as Record<StageId, ResolvedRoute[]>,
  };
}

/** Compatibility shim: rank does not gate reviewer or profile selection. */
export function checkReviewerRule(_profile: ResolvedProfile): string[] {
  return [];
}

/** Resolve a temporary profile without persisting it. */
export function resolveAdHocProfile(
  project: ProjectConfig,
  models: ModelsConfig,
  stages: Record<string, string | string[]>,
  baseProfileName: string,
): ResolvedProfile {
  const base = project.profiles[baseProfileName];
  const merged: ProjectConfig = {
    ...project,
    profiles: {
      ...project.profiles,
      __adhoc: {
        label: `${base?.label ?? baseProfileName} (правка оператора, не сохранена)`,
        stages: { ...(base?.stages ?? {}), ...stages } as Record<StageId, string | string[]>,
      },
    },
  };
  const profile = resolveProfile(merged, models, '__adhoc');
  const problems = checkReviewerRule(profile);
  if (problems.length > 0) throw new ProfileError(problems);
  return profile;
}

/** Профиль, пригодный к старту витка, либо исключение с полным списком причин. */
export function resolveStartableProfile(
  project: ProjectConfig,
  models: ModelsConfig,
  profileName: string,
): ResolvedProfile {
  const profile = resolveProfile(project, models, profileName);
  const problems = checkReviewerRule(profile);
  if (problems.length > 0) throw new ProfileError(problems);
  return profile;
}

/**
 * Маршрут отдельного рецензента из `RunnerConfig.reviewModel`. Живёт вне профиля:
 * настройка едина на раннер, а не на проект/этап. Этап маршрута — `verify`: флаги
 * ручек (`reviewFill`, `claimFill`, …) берутся из записи модели в `config/models.json`,
 * как у любого маршрута этапа 6.
 *
 * Неизвестный id — `ProfileError` со списком проблем, как у маршрутов профиля:
 * рецензент «не той» модели хуже отказа на загрузке.
 */
export function resolveReviewRoute(models: ModelsConfig, modelId: string): ResolvedRoute {
  const problems: string[] = [];
  const route = resolveRoute('verify', modelId, models, problems);
  if (route === null || problems.length > 0) throw new ProfileError(problems);
  return route;
}
