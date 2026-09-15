/** Этап 1 — цель витка: определение этапа и его проверки. */

import { readArtifact } from '../../artifacts/artifact.ts';
import { intentPlaceholdersOutsideTouch } from './preconditions.ts';
import type { StageContext, StageDef } from './types.ts';

/**
 * Та же проверка, что `filledExceptTouchSection` выше (предусловие входа в разведку), но
 * вызванная СВОИМ ходом модели на этапе `intent`, а не чужим предусловием следующего
 * этапа. Общий страж завершения хода (`notDone()`, `Run.ts`) видит только «файл тронут
 * vs пустой бланк», а не «плейсхолдеры закрыты» — `FormFillExecutor` считает точное число
 * оставшихся мест (`fieldsLeftOnDisk`), но кладёт его только в текст сводки, не в решение
 * о готовности, и дозаполнение, тронувшее intent.md и оставившее хотя бы одно место (вне
 * законно пустой «Что придётся тронуть»), уходило зелёным — до входа в `explore` СЛЕДУЮЩЕГО
 * цикла, где чинить уже некому (тот же класс потери, что `explorationPathProblem`/
 * `filesToTouchProblem`, r32; живой разбор серии v5, 2026-09-14: 4 из 22 прогонов упёрлись
 * ровно в это на входе в `explore`).
 */
export function intentPlaceholderProblem(c: StageContext): string | null {
  const a = readArtifact(c.paths.intent);
  if (!a.exists) return null;
  const n = intentPlaceholdersOutsideTouch(a.text);
  if (n === 0) return null;
  return `в intent.md осталось незаполненных мест вне секции «Что придётся тронуть»: ${n} — задача не готова`;
}

export const intentStage: StageDef = {
  id: 'intent',
  skill: 'sdlc-intent',
  title: 'Цель витка',
  // Bash обязателен: скилл заводит ветку витка `sdlc/<slug>` и пересчитывает
  // литеральные примеры приёмки исполнением. Без ветки git diff этапа 5 подхватывает
  // чужую незакоммиченную работу, и scope-гейт краснеет на файлах, которых агент
  // не трогал.
  // `Bash` здесь нет намеренно. Прогон локальных моделей: имея оболочку, модель решает
  // задачу оболочкой — копирует форму в проект и перебирает команды вместо того, чтобы
  // заполнить документ (у 35B двенадцать вызовов из четырнадцати были shell'ом). Этап 1
  // читает, спрашивает человека и пишет артефакт — команда ему не нужна ни для чего.
  tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'AskHuman', 'FinalizeArtifact', 'FillField'],
  subagents: [],
  produces: (c) => [c.paths.gates, c.paths.intent, c.paths.readiness],
  requires: [],
  // На этапе 1 задача и набор гейтов ещё создаются — защищать нечего.
  protectedArtifacts: () => [],
  humanGate: null,
  skipIf: null,
};
