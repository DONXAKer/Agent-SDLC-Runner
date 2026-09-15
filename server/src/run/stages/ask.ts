/** Этап 3 — вопросы: определение условного этапа. */

import { artifactExists, countPlaceholdersExceptDecisions, readArtifact } from '../../artifacts/artifact.ts';
import { autofillClarification } from '../formAutofill.ts';
import { explorationPathsExist } from './explore.ts';
import { RUNTIME_PROTECTED, hasOpenQuestions, isSmallContour } from './preconditions.ts';
import type { StageDef, StageModule } from './types.ts';

export const askStage: StageDef = {
  id: 'ask',
  skill: 'sdlc-ask',
  title: 'Вопросы',
  tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'AskHuman', 'FinalizeArtifact', 'FillField'],
  subagents: [],
  produces: (c) => [c.paths.clarificationReport],
  requires: [
    // На полном контуре разведка обязана быть: без неё «открытых вопросов нет»
    // означает лишь то, что их некому было найти. Пока предусловия не было, этап
    // запускался сразу после первого, читал несуществующий отчёт как пустую строку и
    // штатно «пропускался» — развилки не задавались никому. Мелкий контур разведку не
    // пишет по построению, поэтому там проверка снимается явным ветвлением, как и на
    // этапе 4.
    {
      describe: 'отчёт разведки на месте (либо мелкий контур)',
      artifact: (c) => c.paths.explorationReport,
      check: (c) =>
        isSmallContour(c) || artifactExists(c.paths.explorationReport)
          ? null
          : `нет отчёта разведки ${c.paths.explorationReport}. На полном контуре ` +
            `«открытых вопросов нет» без разведки означает, что искать их было некому.`,
    },
    explorationPathsExist(),
  ],
  protectedArtifacts: RUNTIME_PROTECTED,
  humanGate: null,
  // Условный шаг: нет развилок — нет шага и артефакта.
  skipIf: (c) => {
    if (isSmallContour(c)) return 'мелкий контур: этап не запускается';
    const intent = readArtifact(c.paths.intent);
    const expl = readArtifact(c.paths.explorationReport);
    const open = hasOpenQuestions(intent.text) || hasOpenQuestions(expl.text);
    return open ? null : 'открытых вопросов нет — этап условный, артефакт не создаётся';
  },
};

export const askModule: StageModule = {
  def: askStage,
  formFillExecutor: false,
  leanDocTools: true,
  mechanicalJobs: (host) => [
    {
      path: host.paths.clarificationReport,
      fill: async (t) => autofillClarification(t, { title: host.slug, explorationDone: artifactExists(host.paths.explorationReport) }),
      evenWithoutPlaceholders: true,
    },
  ],
  // `Bash` на этапе нет — сменить ветку внутри хода нечем.
  checksBranchOnEntry: false,
  begin: (host) => ({
    // Полнота отчёта — в ходу САМОГО этапа 3, тем же приёмом и по той же причине, что у
    // `intent` и `explore`: общий страж завершения (`notDone()`) видит только «файл тронут
    // vs пустой бланк», и этап уходил зелёным с незакрытыми местами. Разбор серии v9
    // (2026-09-15): `ask ✅ — модель завершила ход` сразу после строки
    // `✎ clarification-report.md — незаполненных мест: 5`, и отчёт стенда печатал по этому
    // витку щуп «форма артефактов ✅». Щуп не врал — он берёт готовый исход этапа; ложный
    // зелёный приходил отсюда.
    //
    // Строки решений человека не в счёт (`countPlaceholdersExceptDecisions`): «Решение
    // человека о полноте» остаётся плейсхолдером всегда — это humanGate, модели он не
    // отдаётся, и считать его значило бы требовать невыполнимого.
    finishProblem: () => {
      const a = readArtifact(host.paths.clarificationReport);
      if (!a.exists) return null; // условный этап мог не создать артефакт — это законно
      const n = countPlaceholdersExceptDecisions(a.text);
      if (n === 0) return null;
      return (
        `в отчёте по вопросам осталось незаполненных мест: ${n} — этап 4 на входе считает их ` +
        `и не стартует. Замени оставшиеся места «‹…›» содержимым и сохрани инструментом Edit.`
      );
    },
  }),
};
