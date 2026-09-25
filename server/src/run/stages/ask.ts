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
  unreflectedAnswers,
} from '../../artifacts/humanFacts.ts';
import type { OpenQuestion } from '../../artifacts/humanFacts.ts';
import { autofillClarification } from '../formAutofill.ts';
import { seedArtifacts } from '../seed.ts';
import { explorationPathsExist } from './explore.ts';
import { RUNTIME_PROTECTED, hasOpenQuestions, isSmallContour } from './preconditions.ts';
import type { StageDef, StageHost, StageModule } from './types.ts';

/** Открытых вопросов задаётся не больше стольки за один вход в этап — блокирующие первыми. */
const MAX_QUESTIONS_PER_TURN = 4;

/**
 * Отчёт по вопросам «по существу пусто»: строка-образец таблицы и поля формы закрываются
 * записью о том, что вопросов не было, — с подписью оператора, чтобы артефакт был отличим
 * от незаполненного бланка и от пропущенного этапа. Чистая функция — проверяется тестом.
 */
export function emptyClarificationReport(text: string, note: string): string {
  const lines = text.split('\n').map((line) => {
    const t = line.trim();
    if (t.startsWith('| 1 |') && t.includes('‹вопрос›')) return `| — | ${note} | н/п | н/п | ничего |`;
    if (t === '‹уточнённое требование и подход›') return `${note}; требование и подход — как в intent.md`;
    if (t.startsWith('- ‹вопрос›')) return null;
    if (t.startsWith('- **Задача:**')) return line.replace(/‹одно предложение о цели›/, 'см. intent.md');
    return line;
  });
  return lines.filter((l): l is string => l !== null).join('\n');
}

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
  // Отмена отвечает пустым `{}` — это не ответ человека: записанные «(пропущено)» навсегда
  // считались бы заданными, и вопрос, которого человек не видел, больше не задавался бы
  // (code-review-all 2026-09-23).
  if (host.signal().aborted) return;
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

/**
 * Блокирующий ли вопрос МОДЕЛИ — по заголовку карточки: у `AskHuman` отдельного флага нет.
 * `null` — не сказано; ячейка остаётся плейсхолдером `‹да/нет›` для модели, а не
 * догадкой рантайма.
 */
function blockingOfHeader(header: string): boolean | null {
  if (/не\s*блокир/iu.test(header)) return false;
  if (/блокир/iu.test(header)) return true;
  return null;
}

/**
 * Ответ человека на `AskHuman` МОДЕЛИ этапа 3 — в таблицу «Вопросы и ответы» его пишет
 * рантайм, как и ответы на открытые вопросы (`askOpenQuestions`). Колонка «Ответ человека»
 * — поле человека (`artifact.ts::isHumanAnswerCell`), и её транскрипция моделью — та же
 * фабрикация, что вписанное ею имя в «Утвердил»: `humanDecision.ts` её отклоняет. Модели
 * остаётся «Что изменилось в задаче» — суждение, а не факт.
 *
 * Неотвеченный вопрос строки не получает: пустой `{}` — это и отмена, и «человек не
 * ответил», и записанное «(пропущено)» навсегда считалось бы заданным вопросом, которого
 * человек, возможно, не видел (тот же довод, что в `askOpenQuestions`). Вопрос, уже
 * несущий строку, не дублируется.
 */
function recordModelAnswers(
  host: StageHost,
  questions: readonly Question[],
  answers: Readonly<Record<string, string[]>>,
): string | null {
  if (host.signal().aborted) return null;
  const report = readArtifact(host.paths.clarificationReport);
  if (!report.exists) return null;
  const answered = questions
    .map((q) => ({ q, raw: (answers[q.id] ?? []).join(', ').trim() }))
    .filter((a) => a.raw !== '');
  if (answered.length === 0) return null;
  const asOpen = answered.map((a) => ({ question: a.q.question, blocking: false, source: 'intent' as const }));
  const fresh = new Set(unaskedQuestions(asOpen, report.text).map((q) => q.question));
  const toWrite = answered.filter((a) => fresh.has(a.q.question));
  if (toWrite.length === 0) return null;

  const startN = askedQuestionCount(report.text);
  const rows = toWrite.map((a, i) =>
    renderAnswerRow(startN + i + 1, { question: a.q.question, blocking: blockingOfHeader(a.q.header) }, a.raw),
  );
  const updated = appendAnswerRows(report.text, rows);
  if (updated === report.text) return null;
  host.writeAutofilled(host.paths.clarificationReport, updated, []);
  closeIntentQuestions(host, updated);
  const first = startN + 1;
  const last = startN + rows.length;
  const where = first === last ? `строкой ${first}` : `строками ${first}–${last}`;
  return (
    `Рантайм записал ответ в clarification-report.md ${where} таблицы «Вопросы и ответы». ` +
    'Ячейку «Ответ человека» не переписывай — это поле человека; заполни в этой строке ' +
    '«Что изменилось в задаче»' +
    (toWrite.some((a) => blockingOfHeader(a.q.header) === null) ? ' и «Блокирующий» (да/нет)' : '') +
    '.'
  );
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
    // «Этап закрывается артефактом всегда» (`SDLC.md` → этап 3): нет развилок — отчёт всё
    // равно кладётся, с записью «по существу пусто» и подписью оператора. Иначе «отчёта
    // нет, потому что вопросов не было» неотличимо от «этап не запускался». Мелкий контур
    // разведку и вопросы не пишет по построению — там артефакта нет законно.
    onSkip: async () => {
      if (isSmallContour(host.ctx())) return;
      const path = host.paths.clarificationReport;
      if (artifactExists(path)) return;
      const seeded = seedArtifacts([path], host.runner().methodologyDir);
      if (seeded.length === 0) return;
      const date = new Date().toISOString().slice(0, 10);
      // Без имени оператора: рантайм не сочиняет подпись человека (решения здесь не было —
      // вопросов не нашла разведка); источник записи назван честно.
      const note = `по существу пусто — открытых вопросов нет; записано рантаймом · ${date}`;
      const titled = autofillClarification(readArtifact(path).text, {
        title: host.slug,
        explorationDone: artifactExists(host.paths.explorationReport),
      }).text;
      const text = emptyClarificationReport(titled, note);
      host.writeAutofilled(path, text, seeded.map((s) => ({ path: s.path })));
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'ask',
        message: `этап 3 пропущен, но артефакт оставлен: ${path} — «${note}»`,
      });
    },

    beforeExecutor: () => askOpenQuestions(host),
    afterAskHuman: (questions, answers) => recordModelAnswers(host, questions, answers),
    // Дозаполнение отчёта по вопросам по полям — ПОСЛЕ хода, тем же приёмом, что у
    // `explore` (`formFinish`), и по той же находке: свободный ход сжигает лимит на
    // оформлении, а не на содержании, и этап падает с незакрытыми местами (test28,
    // `ministral3-14b-…-compactfill`, 2026-09-23: 8 незакрытых мест в
    // `clarification-report.md`, `ask` не доведён). У `ask` НЕТ `formFillExecutor: true`
    // намеренно — `FormFillExecutor` не умеет `AskHuman`, а смысл этапа в открытом вопросе
    // (см. докстринг `askOpenQuestions`). Но `formFinish` — другой путь: он зовётся ПОСЛЕ
    // основного хода, когда сами открытые вопросы уже отвечены рантаймом в
    // `beforeExecutor` и лежат на диске, — дозаполнению остаётся оформить то, что
    // осталось незаполненным в самом отчёте, тем же completion-без-инструментов, которым
    // explore дозаполняет карту кодовой базы. `AskHuman` дозаполнению звать незачем и
    // нечем: к этому моменту вопросов, требующих человека, в файле уже не осталось.
    formFinish: () => ({
      path: host.paths.clarificationReport,
      forced: false,
      extraBlock: null,
      requireCodeChange: false,
    }),
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
      if (n > 0) {
        return (
          `в отчёте по вопросам осталось незаполненных мест: ${n} — этап 4 на входе считает их ` +
          `и не стартует. Замени оставшиеся места «‹…›» содержимым и сохрани инструментом Edit.`
        );
      }
      // «Что изменилось в задаче» заполнено, но не тем: колонка есть, а числа/цитаты из
      // ОТВЕТА человека в ней не встречаются и claim-N не назван — суждение разошлось
      // с фактом в той же строке (см. `unreflectedAnswers`).
      const stale = unreflectedAnswers(a.text);
      if (stale.length === 0) return null;
      return (
        `«Что изменилось в задаче» разошлось с собственным ответом человека в той же строке: ` +
        stale
          .map((f) => `«${f.question.slice(0, 80)}» — ответ называет ${f.literals.map((l) => l.shown).join(', ')}, а «Что изменилось» — нет`)
          .join('; ') +
        `. Впиши в «Что изменилось» число/условие из ответа, либо назови claim-N, который ` +
        `предстоит поправить на этапе 1, — не пересказывай ответ мимо его цифр.`
      );
    },
  }),
};
