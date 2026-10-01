/**
 * Состояние этапов витка по диску — `StageInfo[]` для страницы живого витка и те же факты
 * для дашборда архивных витков.
 *
 * Жило внутри `GET /api/runs/:id` и требовало живого `Run` только ради `run.ctx`; дашборд
 * обязан считать то же самое без `Run` (конструктор пишет в каталог витка). Одно место
 * расчёта «этап пройден / решение записано» на обе ручки: две копии разошлись бы.
 */

import type { StageId, StageInfo } from '@sdlc-runner/shared';

import { readArtifact, readDecision, readLastDecision } from '../artifacts/artifact.ts';
import { isPreparationV2, approvedPreparationProblem, preparationReviewProblem } from '../artifacts/preparation.ts';
import { artifactPathOf } from '../artifacts/paths.ts';
import { STAGES, STAGE_MODULES } from './stages/index.ts';
import { stageOutputContracts } from './stages/inputs.ts';
import { artifactPlaceholders } from './stages/preconditions.ts';
import type { StageContext, StageDef } from './stages/types.ts';

/**
 * Все артефакты существуют И без плейсхолдеров.
 *
 * «Существует» здесь мало: рантайм САМ раскладывает формы при старте этапа
 * (`seedArtifacts`), и по одному существованию этап, упавший на первом ходу, светился
 * пройденным над нетронутым бланком. Пройденность — «существует И без плейсхолдеров», тем
 * же счётчиком, что у стража завершения.
 */
export function artifactProduced(paths: readonly string[], ctx: StageContext, stageId: StageId): boolean {
  if (stageId === 'plan' && isPreparationV2(ctx.paths) && preparationReviewProblem(ctx.paths) !== null) return false;
  return (
    paths.length > 0 &&
    paths.every((p) => {
      const a = artifactPlaceholders(p, ctx, stageId);
      return a.exists && a.placeholders === 0;
    })
  );
}

/** Путь артефакта со слотом решения человека этапа; `null` — слота нет. */
export function decisionArtifactPath(def: StageDef, ctx: StageContext): string | null {
  if (def.id === 'explore' && isPreparationV2(ctx.paths)) return null;
  return def.humanGate === null ? null : artifactPathOf(ctx.paths, def.humanGate.artifact, ctx.chunk, ctx.attempt);
}

/**
 * Состояние решения человека этапа: `null` — слота нет или артефакт не написан (решать ещё
 * нечего), иначе `granted`/`declined`/`pending`. Тем же разбором, что предусловие следующего
 * этапа (`granted()` в stages): handoff ведёт секции по виткам — решение читается из последней.
 */
export function decisionState(def: StageDef, ctx: StageContext): 'granted' | 'declined' | 'pending' | null {
  const path = decisionArtifactPath(def, ctx);
  if (path === null || def.humanGate === null) return null;
  const a = readArtifact(path);
  if (!a.exists) return null;
  const read = def.humanGate.artifact === 'handoff' ? readLastDecision : readDecision;
  const d = read(a.text, def.humanGate.label).state;
  if (def.id === 'plan' && d === 'granted' && approvedPreparationProblem(ctx.paths) !== null) return 'pending';
  return d === 'granted' ? 'granted' : d === 'declined' ? 'declined' : 'pending';
}

/** «Записано» — это `granted`, а не факт, что поле вообще существует в шаблоне. */
export function decisionRecorded(def: StageDef, ctx: StageContext): boolean {
  return decisionState(def, ctx) === 'granted';
}

/**
 * Решение ждёт человека: слот есть, артефакт написан, а решение не записано. Тем же
 * разбором, что предусловие следующего этапа — `waitingCount` живой ручки и дашборд.
 */
export function pendingDecisionCount(ctx: StageContext): number {
  return STAGES.filter((s) => {
    const st = decisionState(s, ctx);
    return st !== null && st !== 'granted';
  }).length;
}

export interface StageInfoDeps {
  blockers(stage: StageId, opts?: { abortHandoff?: boolean }): string[];
  envNotes?(stage: StageId): string[];
}

export function stageInfos(ctx: StageContext, deps: StageInfoDeps): StageInfo[] {
  return STAGES.map((s) => {
    const out = s.produces(ctx);
    const envNotes = deps.envNotes?.(s.id);
    return {
      id: s.id,
      title: s.title,
      tools: s.tools,
      blockers: deps.blockers(s.id),
      // У handoff'а вход двойной, и предусловия у входов разные — см. `abortBlockers`.
      abortBlockers: s.id === 'handoff' ? deps.blockers(s.id, { abortHandoff: true }) : null,
      ...(envNotes === undefined ? {} : { envNotes }),
      produces: out,
      outputContracts: stageOutputContracts(s, ctx),
      runtimeFacts: [...STAGE_MODULES[s.id].runtimeFacts],
      // Факт с диска тем же чтением, что блокеры: клиентская эвристика «дальний этап без
      // блокеров = всё до него пройдено» врала на этапах с общими предусловиями (ask и
      // plan разблокированы сразу после intent, до всякой разведки) — см. StageInfo.produced.
      produced: artifactProduced(out, ctx, s.id),
      // Этап, который методология пропускает СЕЙЧАС (мелкий контур, вопросов нет):
      // артефакта у него не будет никогда, и без этого признака интерфейс вечно
      // предлагал бы его как следующий шаг.
      skipped: s.skipIf !== null && s.skipIf(ctx) !== null,
      decision: s.id === 'explore' && isPreparationV2(ctx.paths) ? null : s.humanGate,
      decisionRecorded: decisionRecorded(s, ctx),
    };
  });
}
