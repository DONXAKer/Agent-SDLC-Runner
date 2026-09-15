/** Этап 1 — цель витка: определение этапа и его проверки. */

import { DecisionFormError, readArtifact, readField, setDecision } from '../../artifacts/artifact.ts';
import { currentBranch, isRepo } from '../../gates/git.ts';
import { autofillReadiness } from '../formAutofill.ts';
import { claimsMinimum, intentPlaceholdersOutsideTouch } from './preconditions.ts';
import type { SeededArtifact, StageContext, StageDef, StageHost, StageModule } from './types.ts';

/**
 * Факт прогона для этапа 1: на какой ветке РЕАЛЬНО стоит рабочее дерево.
 *
 * Тем же приёмом и по той же причине, что итоги гейтов на этапе 6 и пост-виток отчёт на
 * этапе 7: рантайм подкладывает то, что знает сам, вместо того чтобы модель это угадывала.
 *
 * Пойман живым свипом 2026-09-08: четыре прогона `gpt-oss-20b` встали на этапе 4 со сверкой
 * ветки — в `intent.md` записан слаг прогона (`sdlc/n2-gptoss-silent-contract`) вместо ветки,
 * названной задачей (`sdlc/silent-contract`). Модель вывела имя из пути `.sdlc/<слаг>/`, и
 * подсказка формы её к этому подталкивает: «‹sdlc/слаг или по конвенции проекта›».
 *
 * Важно, чего блок НЕ делает: он не заполняет поле за модель и не ослабляет сверку
 * (`branchMismatchBlocker` остаётся на месте). Он только лишает модель повода гадать —
 * ровно как блок гейтов лишает её повода сочинять статусы прогона.
 */
export async function branchFactBlock(root: string): Promise<string | null> {
  if (!(await isRepo(root))) return null;
  const branch = await currentBranch(root);
  if (branch === null || branch.trim() === '') return null;
  return [
    '## Факт прогона: ветка рабочего дерева',
    '',
    `Рабочее дерево стоит на ветке \`${branch}\`.`,
    '',
    'Поле «Ветка витка» в `intent.md` обязано совпасть с этой строкой дословно. Не выводи',
    'имя из путей `.sdlc/…` и не придумывай по конвенции: Runner сверяет поле с фактическим',
    'состоянием дерева и блокирует этап 4 при расхождении.',
  ].join('\n');
}

/**
 * Заполняет поле «Ветка витка» в `intent.md` фактом рантайма — тем же приёмом, что
 * `autofillJournal` у механических полей журнала chunk'а.
 *
 * `branchFactBlock` в промпте только СООБЩАЛ модели факт и оставлял заполнение ей —
 * поле оставалось местом, где модель гадает или выводит имя из путей `.sdlc/…`, хотя
 * ответ детерминирован и рантайму известен ДО хода (`docs/proposals/
 * model-flow-improvements.md` §1.7/§2.1 п.3: «прямое нарушение собственного принципа
 * методологии „механические поля заполняет программа“»). `branchMismatchBlocker`
 * остаётся на месте без изменений — сверка поля с фактическим деревом на входе
 * `plan`/`chunk`/`verify`/`handoff` не ослабляется, здесь лишь снимается сам повод
 * гадать. Молча выходит, если поля нет в шаблоне (не git-репозиторий, поле уже
 * заполнено моделью, или задача принесла артефакт без этого поля вовсе) — поле по
 * форме опционально, тем же условием, что уже сторожит `branchMismatchBlocker`.
 */
export async function autofillBranchField(host: StageHost, seeded: SeededArtifact[]): Promise<void> {
  const path = host.paths.intent;
  const artifact = readArtifact(path);
  if (!artifact.exists) return;
  if (!(await isRepo(host.projectRoot))) return;
  const branch = await currentBranch(host.projectRoot);
  if (branch === null) return;
  // Поле уже заполнено (моделью на прошлой попытке, или задачей заранее) — не трогаем:
  // тот же приём, что у `readField`/`branchMismatchBlocker`, «плейсхолдер или пусто»
  // не считается заполнением.
  if (readField(artifact.text, 'Ветка витка') !== null) return;
  let text: string;
  try {
    text = setDecision(artifact.text, 'Ветка витка', branch);
  } catch (e) {
    if (e instanceof DecisionFormError) return; // поля нет в этом шаблоне — законно
    throw e;
  }
  host.writeAutofilled(path, text, seeded);
  host.emit({
    type: 'warning',
    runId: host.id,
    stage: 'intent',
    message: `рантайм заполнил поле «Ветка витка» фактом дерева (\`${branch}\`) — модели гадать не о чем`,
  });
}

/**
 * Та же проверка, что `filledExceptTouchSection` (`preconditions.ts`, предусловие входа в разведку), но
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

export const intentModule: StageModule = {
  def: intentStage,
  formFillExecutor: true,
  leanDocTools: true,
  mechanicalJobs: (host) => {
    const date = new Date().toISOString().slice(0, 10);
    return [{ path: host.paths.readiness, fill: async (t) => autofillReadiness(t, { title: host.slug, date, run: 1 }) }];
  },
  // На входе поле «Ветка витка» ещё не заполнено — сверять нечего.
  checksBranchOnEntry: false,
  begin: (host) => ({
    // Ветка рабочего дерева — вход этапа 1, тем же механизмом, что итоги гейтов этапа 6:
    // рантайм знает её точно, и модели незачем выводить имя из путей `.sdlc/…` (свип
    // 2026-09-08, см. комментарий у `branchFactBlock`).
    enterFacts: async () => {
      const block = await branchFactBlock(host.projectRoot);
      return block === null ? [] : [block];
    },

    // «Ветка витка» — та же логика: рантайм знает ответ детерминированно (git-дерево),
    // модели гадать не о чем. Только на intent — это единственный этап, где поле ещё не
    // заполнено (`branchMismatchBlocker` сверяет его на входе plan/chunk/verify/handoff).
    autofill: (seeded) => autofillBranchField(host, seeded),

    // Полнота intent.md — здесь, а не только предусловием этапа 2. `notDone()`
    // выше видит только «файл тронут vs пустой бланк»: дозаполнение, тронувшее
    // intent.md и оставившее хотя бы одно место (вне законно пустой «Что придётся
    // тронуть»), уходило зелёным — до входа в `explore` СЛЕДУЮЩЕГО цикла, где
    // чинить уже некому (тот же класс потери, что карта разведки; живой
    // разбор серии v5, 2026-09-14: 4 из 22 прогонов упёрлись ровно в это).
    finishProblem: () => {
      const problem = intentPlaceholderProblem(host.ctx());
      if (problem !== null) {
        return `${problem}. Замени оставшиеся места «‹…›» содержимым и сохрани инструментом Edit.`;
      }
      // Минимум приёмочного листа — той же проверкой, что стоит предусловием входа в
      // разведку (`claimsMinimum`), но в ходу САМОГО этапа 1. Пока она была только
      // предусловием, недобор выглядел так: дозаполнение честно писало «добор поля
      // приемочный лист не закрыл минимум за 2 попытки: строк 11 (нужно 3), [edge] 0
      // (нужно 2) — этап 3 отклонит», этап всё равно закрывался ✅, и виток вставал на
      // входе разведки, где чинить уже некому (разбор серии v9, 2026-09-15). Тот же класс
      // потери, что `intentPlaceholderProblem` рядом.
      return claimsMinimum().check(host.ctx());
    },
  }),
};
