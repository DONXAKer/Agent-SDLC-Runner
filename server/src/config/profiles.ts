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

/**
 * Правило рецензента.
 *
 * Методология требует, чтобы рецензент этапа 6 был строго сильнее исполнителя этапа 5:
 * иначе ревью становится декорацией. «Ревью независимым агентом» входит в минимальную
 * пятёрку гейтов, у которой переключателя нет, поэтому тихо понизить рецензента нельзя —
 * виток просто не стартует.
 *
 * Санкционированный выход один: смешанный профиль, где `verify` пришпилен к более сильной
 * модели (например, к Claude при локальном остальном).
 */
export function checkReviewerRule(profile: ResolvedProfile): string[] {
  const chunkRoutes = profile.ensemble?.chunk ?? [profile.routes.chunk];
  const verifyRoutes = profile.ensemble?.verify ?? [profile.routes.verify];
  if (chunkRoutes.length === 0 || verifyRoutes.length === 0) return [];
  if (chunkRoutes.some((r) => r === undefined) || verifyRoutes.some((r) => r === undefined)) {
    return [];
  }

  // Сравниваются КРАЙНИЕ значения: минимальный rank среди рецензентов против максимального
  // среди исполнителей. Иначе ансамбль становится способом протащить слабого рецензента
  // рядом с сильным — правило выполнялось бы «в среднем», а слабый всё равно голосовал бы.
  const chunk = chunkRoutes.reduce((a, b) => (a.rank >= b.rank ? a : b));
  const verify = verifyRoutes.reduce((a, b) => (a.rank <= b.rank ? a : b));

  if (verify.rank > chunk.rank) return [];

  return [
    `профиль «${profile.name}»: рецензент этапа 6 не сильнее исполнителя этапа 5 ` +
      `(слабейший verify=${verify.modelId} rank=${verify.rank}, сильнейший chunk=${chunk.modelId} rank=${chunk.rank}).\n` +
      `Методология требует строгого превосходства — иначе ревью становится декорацией, ` +
      `а «Ревью независимым агентом» входит в минимальную пятёрку гейтов и выключателя не имеет.\n` +
      `Подними модель на verify или заведи смешанный профиль, где verify идёт на более сильном маршруте.`,
  ];
}

/**
 * Профиль, собранный оператором на один виток и НИКУДА не сохраняемый.
 *
 * Судьба правки названа явно: она применяется к создаваемому прогону и на диск не
 * попадает. Писать `config/projects/*.json` из интерфейса — отдельное решение с отдельными
 * рисками (файл правят и руками, и параллельно), и молча делать это здесь нельзя.
 */
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
