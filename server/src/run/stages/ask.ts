/** Этап 3 — вопросы: определение условного этапа. */

import type { Question } from '@sdlc-runner/shared';

import { artifactExists, countPlaceholdersExceptDecisions, readArtifact } from '../../artifacts/artifact.ts';
import {
  appendAnswerRows,
  askedQuestionCount,
  closeAnsweredQuestions,
  extractHumanFacts,
  openQuestions,
  renderAnswerRow,
  unaskedQuestions,
} from '../../artifacts/humanFacts.ts';
import type { OpenQuestion } from '../../artifacts/humanFacts.ts';
import { autofillClarification } from '../formAutofill.ts';
import { explorationPathsExist } from './explore.ts';
import { RUNTIME_PROTECTED, hasOpenQuestions, isSmallContour } from './preconditions.ts';
import type { StageDef, StageHost, StageModule } from './types.ts';

/** Открытых вопросов задаётся не больше стольки за один вход в этап — блокирующие первыми. */
const MAX_QUESTIONS_PER_TURN = 4;

/**
 * Вопрос человеку задаёт рантайм, не модель (3.4 / S1): открытые вопросы уже полностью
 * сформулированы в `intent.md`/`exploration-report.md` (этапы 1–2), и рантайм спрашивает
 * их напрямую через `host.askHuman` — тем же `AskGate`, что и `AskHuman` модели, но БЕЗ
 * хода модели между вопросом и записью в отчёт. Снимает измеренную находку «ответ в
 * чате, не в задаче»: ответ ложится в `clarification-report.md` рантаймом, а не зависит
 * от того, перенесёт ли модель его из диалога в файл.
 *
 * Вызывается ДО хода модели (`beforeExecutor`) — тем же местом, что уже занят слепым
 * листом разведки (`explore.ts`): к моменту, когда модель получит промпт, отчёт уже несёт
 * отвеченные (или честно пропущенные) строки, и падать в тот же цикл «спросить самой» ей
 * незачем. Идемпотентно: `unaskedQuestions` не даёт задать один вопрос дважды на
 * повторном входе в этап.
 */
async function askOpenQuestions(host: StageHost): Promise<void> {
  const intent = readArtifact(host.paths.intent);
  const expl = readArtifact(host.paths.explorationReport);
  const all = openQuestions(intent.exists ? intent.text : '', expl.exists ? expl.text : '');
  if (all.length === 0) return;

  const report = readArtifact(host.paths.clarificationReport);
  if (!report.exists) return; // seedArtifacts ещё не разложил бланк — беречь нечего

  const fresh = unaskedQuestions(all, report.text);
  if (fresh.length === 0) return;

  // Блокирующие — первыми: если в вопросов больше, чем помещается за один вход, именно
  // они не должны ждать следующего.
  const batch = [...fresh].sort((a, b) => Number(b.blocking) - Number(a.blocking)).slice(0, MAX_QUESTIONS_PER_TURN);
  const questions: Question[] = batch.map((q, i) => ({
    id: `open-${i}`,
    question: q.question,
    header: q.blocking ? 'Блокирующий вопрос задачи' : 'Вопрос задачи',
    multiSelect: false,
    // Вопрос уже свободной формы («какая ставка для …?») — готовых вариантов у рантайма
    // нет и придумывать их не его дело; интерфейс всегда даёт поле свободного ответа.
    options: [],
  }));

  const answers = await host.askHuman('ask', questions);
  const startN = askedQuestionCount(report.text);
  const rows = batch.map((q: OpenQuestion, i) => {
    const raw = (answers[`open-${i}`] ?? []).join(', ').trim();
    return renderAnswerRow(startN + i + 1, q, raw === '' ? null : raw);
  });
  const updated = appendAnswerRows(report.text, rows);
  if (updated !== report.text) host.writeAutofilled(host.paths.clarificationReport, updated, []);

  // Закрываем чек-бокс СРАЗУ, а не ждём следующего входа в этап: `mechanicalJobs`
  // (закрытие intent.md) выполняется рантаймом ДО этого хука в `runStage`, то есть на
  // момент его прогона ответ ещё не был дописан в отчёт — без повторного закрытия здесь
  // вопрос, отвеченный в ЭТОМ ЖЕ входе, навсегда оставался бы с открытым чек-боксом
  // (ревью code-review-all, 2026-09-19; этап `ask` однопроходный, второго входа обычно
  // не бывает).
  closeIntentQuestions(host, updated);
}

/** Закрывает чек-боксы «Открытых вопросов» intent.md по ФАКТУ переданного текста отчёта. */
function closeIntentQuestions(host: StageHost, reportText: string): void {
  const intent = readArtifact(host.paths.intent);
  if (!intent.exists) return;
  const facts = extractHumanFacts(reportText);
  const { text, closed } = closeAnsweredQuestions(intent.text, facts);
  if (closed > 0) host.writeAutofilled(host.paths.intent, text, []);
}

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
    // closeAnsweredQuestions (3.1): рантайм сам закрывает чек-боксы «Открытых вопросов»
    // задачи ответами из отчёта — модели нечего править в intent.md, а редактировать его
    // ей и не разрешено (RUNTIME_PROTECTED). Снимает измеренный цикл #9 («Edit → отказ →
    // „начать план?“»), см. докстринг `closeAnsweredQuestions`.
    {
      path: host.paths.intent,
      fill: async (t) => {
        const report = readArtifact(host.paths.clarificationReport);
        const facts = report.exists ? extractHumanFacts(report.text) : [];
        const { text, closed } = closeAnsweredQuestions(t, facts);
        return { text, filled: closed };
      },
      evenWithoutPlaceholders: true,
    },
  ],
  // `Bash` на этапе нет — сменить ветку внутри хода нечем.
  checksBranchOnEntry: false,
  begin: (host) => ({
    beforeExecutor: () => askOpenQuestions(host),
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
