/**
 * Этап 6 — верификация: определение этапа и его точки в `runStage`. Гейты — `gates.ts`,
 * записи рецензента — `records.ts`, ревью рантаймом — `reviewer.ts`, ансамбль —
 * `ensemble.ts`, вердикт — `verdict.ts`, состояние попытки — `state.ts`.
 */

import { DECISION } from '../../../artifacts/artifact.ts';
import { preflightBlockers } from '../../../sandbox/preflight.ts';
import { RUNTIME_PROTECTED, exists, granted } from '../preconditions.ts';
import type { StageDef, StageModule } from '../types.ts';
import { gateReportBlock, runVerifyGates } from './gates.ts';
import { autofillVerification, verifyGaps } from './records.ts';

export const verifyStage: StageDef = {
  id: 'verify',
  skill: 'sdlc-verify',
  title: 'Верификация',
  // Оболочки здесь НЕТ, и это следствие двух правок, а не экономия прав: патч
  // перегенерирует рантайм (`run/evidence.ts`), гейты он же прогоняет до рецензента и
  // подклеивает их фактический итог ко входу. Всё, ради чего рецензенту нужна была
  // командная строка, приходит к нему готовым — а замер показал, чем она оборачивается
  // на слабой модели: 7 вызовов из 7 ушли в `Bash`, отчёт остался бланком
  // (`docs/model-runs.md`, этап 6). Проверка утверждений по коду остаётся:
  // `Read`/`Grep`/`Glob` при рецензенте.
  //
  // Edit нужен, чтобы обновить колонку «Итог» строки попытки в журнале chunk'а —
  // без него единственный способ это Write целиком, то есть верификатор переписывает
  // журнал исполнителя своей реконструкцией и уничтожает улику этапа 5.
  //
  // `RecordClaim`/`RecordFinding` — структурированный канал вывода: пункты приёмки и
  // находки модель называет записями, а таблицу §1 и строки §2–§5 рисует рантайм.
  // Заведено против измеренного класса отказа «форма отчёта не разобралась»: вердикт
  // по пустому входу стоит ровно столько же, сколько несделанная работа. Обычные
  // Write/Edit остаются — модель, справляющаяся с формой сама, ничего не теряет.
  tools: [
    'Read',
    'Glob',
    'Grep',
    'Write',
    'Edit',
    'Task',
    'AskHuman',
    'FinalizeArtifact',
    'FillField',
    'RecordClaim',
    'RecordFinding',
  ],
  subagents: ['sdlc-reviewer'],
  produces: (c) => [c.paths.verificationReport(c.chunk, c.attempt)],
  requires: [
    exists('журнал chunk’а на месте', (c) => c.paths.chunkJournal(c.chunk)),
    exists('патч попытки на месте', (c) => c.paths.chunkDiff(c.chunk, c.attempt)),
    exists('набор гейтов проекта на месте', (c) => c.paths.gates),
    granted(
      'место правки подтверждено человеком',
      (c) => c.paths.chunkJournal(c.chunk),
      DECISION.confirmed,
    ),
  ],
  protectedArtifacts: RUNTIME_PROTECTED,
  humanGate: null,
  skipIf: null,
};

export const verifyModule: StageModule = {
  def: verifyStage,
  formFillExecutor: false,
  leanDocTools: false,
  checksBranchOnEntry: true,
  missingSubagentsNote:
    'Этап 6 пойдёт без независимого рецензента, а «Ревью независимым агентом» ' +
    'входит в минимальную пятёрку гейтов — вердикт этого витка неполон.',
  begin: (host) => ({
    // Кэш предыдущего pre-flight сбрасывается ДО проверки блокеров: если прошлая
    // попытка упала на пробе среды, `lastPreflightBlockers` от неё ещё не пуст, а
    // `blockers()` теперь подмешивает его в свой список (см. её комментарий) — без сброса
    // здесь виток заблокировал бы сам себя устаревшим результатом, ни разу не пройдя до
    // свежей проверки ниже, и retry стал бы физически недостижим.
    resetOnEnter: () => {
      host.verifyState.lastPreflightBlockers = [];
    },

    // Только «Тесты»/«Сборка» реально идут через `runShell`, и только на этапе 6 — pre-flight
    // здесь, а не после запуска модели: несоответствие среды раньше обнаруживалось только
    // прогоном самих гейтов, то есть после того, как разведка и отчёт уже съели попытку.
    // До `nextAttempt()` (отдельный метод, не вызывается отсюда) — попытка не тратится.
    // ПОСЛЕ проверки `report.skip`, не до неё: у `verify` пропуска сегодня не бывает
    // (`skipIf` для него всегда `null`), но если он появится — pre-flight не
    // должен блокировать попытку, которая всё равно была бы пропущена без него.
    entryBlocker: async () => {
      const sandboxBlockers = await preflightBlockers(host.projectRoot, host.projectName);
      host.verifyState.lastPreflightBlockers = sandboxBlockers;
      return sandboxBlockers.length > 0 ? sandboxBlockers.join('\n') : null;
    },

    // Гейты этапа 6 прогоняются до рецензента и подклеиваются к его входу: иначе он
    // судит по своему представлению о сборке и тестах, а не по их фактическому итогу.
    enterFacts: async (signal) => {
      // Записи принадлежат ПОПЫТКЕ: перезапуск этапа начинает отчёт заново, и пункты
      // прошлого прогона не должны в него переезжать — той же логикой, по которой отчёты
      // прошлых попыток закрыты на чтение.
      host.verifyState.claimRecords.clear();
      host.verifyState.findingRecords = [];
      host.verifyState.anchorHaystack = null;
      host.verifyState.reviewFillComplete = false;

      const results = await runVerifyGates(host, signal);
      return results.length > 0 ? [gateReportBlock(results)] : [];
    },

    // Отчёт приёмки: механику шапки и таблицу «Гейты» заполняет рантайм фактами только
    // что прогнанных гейтов — рецензенту остаются выводы и ревью. Замер r9: все
    // расхождения «отчёт/факт» дешёвого рецензента были в переписанной от себя таблице.
    autofill: async (seeded) => autofillVerification(host, seeded),

    // Этап 6: бланк, тронутый одной правкой, «произведённым» не считается — сверка байт
    // в байт пропускала отчёт с зелёными статусами при нетронутом тексте пунктов и без
    // строк на половину листа задачи (замер 2026-09-08, локальный рецензент). Здесь
    // считается содержание по пунктам ЗАДАЧИ; оформление остаётся дозаполнению.
    extraNotDone: () => verifyGaps(host),
  }),
};
