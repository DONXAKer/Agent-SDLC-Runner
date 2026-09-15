/** Этап 4 — план витка: определение этапа и проверка `files_to_touch`. */

import { DECISION, artifactExists, readArtifact } from '../../artifacts/artifact.ts';
import { SDLC_DIR } from '../../artifacts/paths.ts';
import { extractFilesToTouch } from '../../artifacts/planFiles.ts';
import { explorationPathsExist } from './explore.ts';
import { claimsMinimum, filled, isSmallContour, relOf } from './preconditions.ts';
import type { StageContext, StageDef } from './types.ts';

/**
 * `files_to_touch` плана пуст — та же находка, что уже ловит `Run.blockers()` на входе в
 * `chunk` (`PlanScope выключился бы молча`), но здесь она приходит модели в её собственном
 * ходу на этапе `plan`, а не после ухода планировщика: без этой проверки виток тратил целый
 * холостой цикл — план закрывался зелёным, а бесполезность вскрывалась только на входе в
 * `chunk` (живой замер `gemma-4-e4b`/`security-bait`, 2026-09-13). Пустой список никогда не
 * легитимен в текущей архитектуре: `chunk.skipIf` отсутствует, `planScope.ts` трактует
 * пустой `files_to_touch` как «защита выключена», а не как «нечего трогать».
 *
 * Переиспользует `extractFilesToTouch` — тот же разбор секции, что и `Run.planFilesFor`
 * (второй парсер здесь завёл бы риск расхождения, см. предупреждение в `planFiles.ts`).
 */
export function filesToTouchProblem(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null; // отсутствие плана ловит соседнее предусловие
  if (extractFilesToTouch(plan.text).length > 0) return null;
  return (
    `в files_to_touch плана нет ни одного пути: без него PlanScope выключится молча на ` +
    `этапе 5, и запись перестанет быть ограниченной планом. Впиши хотя бы один путь строкой ` +
    `таблицы.`
  );
}

export const planStage: StageDef = {
  id: 'plan',
  skill: 'sdlc-plan',
  title: 'План витка',
  // Bash — для `git rev-parse HEAD` в поле «База».
  // Оболочки нет по той же причине, что на этапе 1: план — это документ, а не прогон
  // команд. Разведка, которой нужно смотреть в дерево, идёт этапом раньше и своими
  // инструментами чтения.
  tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'AskHuman', 'FinalizeArtifact', 'FillField'],
  subagents: [],
  produces: (c) => [c.paths.plan, c.paths.readiness],
  requires: [
    {
      describe: 'отчёт разведки на месте (или мелкий контур)',
      artifact: (c) => c.paths.explorationReport,
      check: (c) =>
        isSmallContour(c) || artifactExists(c.paths.explorationReport)
          ? null
          : `нет файла ${c.paths.explorationReport}. На мелком контуре разведка не ` +
            `запускается — тогда пометь это в поле «Контур» задачи.`,
    },
    filled('задача заполнена без плейсхолдеров', (c) => c.paths.intent),
    explorationPathsExist(),
    // И здесь тоже, не только на explore: мелкий контур пропускает разведку целиком
    // (`explore.skipIf`), и без этой строки его ветка `small ? 1 : 3` внутри проверки
    // была мертва — пустой лист доезжал до вердикта.
    claimsMinimum(),
  ],
  // План здесь и создаётся, поэтому защищены только задача и набор гейтов.
  protectedArtifacts: (c) => [`${SDLC_DIR}/gates.md`, relOf(c, c.paths.intent)],
  humanGate: { artifact: 'plan', label: DECISION.approval },
  skipIf: null,
};
