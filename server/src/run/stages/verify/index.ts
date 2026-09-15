/**
 * Этап 6 — верификация: определение этапа и его точки в `runStage`. Гейты — `gates.ts`,
 * записи рецензента — `records.ts`, ревью рантаймом — `reviewer.ts`, ансамбль —
 * `ensemble.ts`, вердикт — `verdict.ts`, состояние попытки — `state.ts`.
 */

import { emptyUsage } from '@sdlc-runner/shared';

import { DECISION } from '../../../artifacts/artifact.ts';
import { preflightBlockers } from '../../../sandbox/preflight.ts';
import { RUNTIME_PROTECTED, exists, granted } from '../preconditions.ts';
import type { StageDef, StageModule } from '../types.ts';
import { runEnsembleReviewers } from './ensemble.ts';
import { diffStillMatchesTree, gateReportBlock, runVerifyGates } from './gates.ts';
import { applyRecords, autofillVerification, topUpClaims, verifyGaps } from './records.ts';
import { reviewerBlock, runReviewFill, runReviewerDirectly } from './reviewer.ts';

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
  begin: (host, route) => ({
    // Независимое ревью — шаг РАНТАЙМА, идущий до хода модели этапа (тем же порядком,
    // что и автоматические гейты). Его текст приходит модели готовым блоком: ей остаётся
    // перенести находки в §2–§5 отчёта, а не догадаться позвать `Task`. Не состоялось —
    // `null`, и тогда всё как раньше: у модели остаётся собственный вызов субагента.
    // Рецензент: свободный ход субагента либо — на flow `loop` с `reviewFill` — конвейер
    // закрытых вопросов по хункам. Одно место выбора, чтобы гейт ревью и вход этапа
    // ставились по одному и тому же прогону.
    preTurn: async (prompt, agents, hooks) => {
      const reviewText =
        route.flow === 'loop' && route.reviewFill
          ? await runReviewFill(host, route)
          : await runReviewerDirectly(host, prompt, agents, hooks);

      // R1.1: конвейер `reviewFill`, прошедший ПОЛНОСТЬЮ, закрывает разбор diff'а сам —
      // собственный ход модели читал бы тот же diff ещё раз, в одном большом запросе,
      // и ровно это не проходило по бюджету у моделей без ручки эффорта (Apriel-1.6-15B,
      // qwen3.8-27b: конвейер из коротких вопросов проходил целиком, а следующий за ним
      // свободный ход — нет; замеры 2026-09-08). §1 добирает `topUpClaims` (тоже короткими
      // вопросами, вызывается после хода независимо от этого пропуска), прочее оформление —
      // дозаполнение по полям (`route.formFill`, тоже короткими запросами). Неполный
      // конвейер (диффа нет, часть вопросов не отвечена) собственный ход НЕ пропускает —
      // тогда разбора не было вовсе, и заменить его нечем.
      //
      // `route.skipTurnAfterReviewFill` — а не автоматика по факту полного конвейера: на
      // быстрой модели (100 % GPU) пропуск хода делает этап МЕДЛЕННЕЕ (дозаполнение по
      // полям поле-за-полем дороже, чем несколько ходов агентного цикла с батчем правок,
      // замер 2026-09-08) — ручка нужна там, где измеренно помогает, не всем.
      const skipModelTurn =
        route.flow === 'loop' &&
        route.reviewFill &&
        route.skipTurnAfterReviewFill &&
        host.verifyState.reviewFillComplete;

      return {
        block: reviewText === null ? null : reviewerBlock(reviewText),
        skip: skipModelTurn
          ? {
              ok: true,
              finalText: reviewText ?? '',
              usage: emptyUsage(),
              note:
                'ход модели пропущен: reviewFill прошёл конвейер целиком — отчёт закрывается ' +
                'его записями, добором по пунктам приёмки и дозаполнением по полям, без второго ' +
                'свободного прохода по тому же diff\'у',
            }
          : null,
      };
    },

    afterTurn: async (stagePrompt, signal) => {
      // Поклаймовый добор (`ModelDef.claimFill`): пункты, о которых модель не сказала
      // ничего, добираются по одному вопросу со срезом патча. ДО внесения записей —
      // добранное идёт в отчёт тем же путём, что записанное вручную.
      if (route.flow === 'loop' && (route.claimFill || route.reviewFill) && !signal.aborted) {
        await topUpClaims(host, route, stagePrompt.system);
      }

      // Записи рецензента вносятся в отчёт ДО дозаполнения по полям и до ансамбля:
      // дозаполнение считает оставшиеся плейсхолдеры, а маршруты ансамбля снимают копию
      // канонического отчёта — оба обязаны видеть уже внесённые пункты и находки.
      await applyRecords(host);
    },

    // Дозаполнение отчёта приёмки по полям (замер r9: рецензенту 14B при лимите 40 не
    // хватало ходов именно на оформление отчёта). До ансамбля: дополнительные маршруты
    // снимают копию канонического отчёта, и она обязана быть полной.
    formFinish: () => ({
      path: host.paths.verificationReport(host.chunk(), host.attempt()),
      forced: false,
      extraBlock: null,
      requireCodeChange: false,
    }),

    afterForm: (prompt, def, agents, hooks) => runEnsembleReviewers(host, prompt, def, agents, hooks),

    // Вердикт считается сразу после этапа 6 — по отчёту, который только что записан,
    // и по прогону гейтов, который был до ревью. Отдельной кнопки у него нет: вердикт,
    // который надо не забыть посчитать, рано или поздно не считают.
    verdict: async () => {
      // Сверку патча с деревом делает рантайм и делает её ЗДЕСЬ — после ревью, но до
      // подсчёта вердикта: раньше это условие держалось на фразе рецензента (r31).
      host.verifyState.diffFactMatchesTree = await diffStillMatchesTree(host);
      host.computeStageVerdict(host.detectNoProgress());
    },

    // Прогресс этапа 6 — принятые записи отчёта. Анти-цикл обрывает этап только
    // тогда, когда за серию повторов не прибавилось ничего: обрыв посреди
    // заполняемого отчёта терял работу, уже сделанную (и оплаченную) целиком.
    progress: () => ({
      progressSignal: () => host.verifyState.claimRecords.size + host.verifyState.findingRecords.length,
      // Совет по умолчанию в LoopExecutor зовёт Edit — на verify прогресс это
      // RecordClaim/RecordFinding, а Edit противоречит независимости ревью
      // (`CLAUDE.md` → «Этап 6…»; code-review-all, 2026-09-14).
      progressHint:
        'переходи к записи находок инструментами RecordClaim/RecordFinding прямо ' +
        'сейчас, бюджет ходов не резиновый.',
    }),

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
