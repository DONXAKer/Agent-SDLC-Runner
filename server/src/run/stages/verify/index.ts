/**
 * Этап 6 — верификация: определение этапа и его точки в `runStage`. Гейты — `gates.ts`,
 * записи рецензента — `records.ts`, ревью рантаймом — `reviewer.ts`, ансамбль —
 * `ensemble.ts`, вердикт — `verdict.ts`, состояние попытки — `state.ts`.
 */

import { emptyUsage } from '@sdlc-runner/shared';

import { DECISION, readArtifact } from '../../../artifacts/artifact.ts';
import { autofillJournalOutcome } from '../../journalAutofill.ts';
import { writeRunVerdict } from '../../verdictStore.ts';
import { writeEvidenceLines, writeGateRowStatus, writeVerdictSection } from '../../verifyAutofill.ts';
import { preflightGateBlockers } from '../../../gates/preflight.ts';
import { preflightBlockers } from '../../../sandbox/preflight.ts';
import { RUNTIME_PROTECTED, exists, granted, intentSectionsIntact, intentTamperedSections } from '../preconditions.ts';
import { planClarificationProblem, planRequirementsProblem } from '../plan.ts';
import type { StageDef, StageModule } from '../types.ts';
import { runEnsembleReviewers } from './ensemble.ts';
import { RECONCILE_GATE, REVIEW_GATE, attemptEvidenceFact, diffStillMatchesTree, gateReportBlock, runVerifyGates } from './gates.ts';
import { applyRecords, autofillVerification, topUpClaims, verifyGaps, finishGuidedVerification } from './records.ts';
import { readGuided } from '../../guidedState.ts';
import { routeKey } from '../../reviewRoute.ts';
import { acceptReviewText, reviewerBlock, runReviewFill, runReviewerDirectly } from './reviewer.ts';
import { writeReviewJson } from './reviewJson.ts';

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
  // Колонку «Итог» строки попытки в журнале chunk'а раньше правил Edit модели — теперь
  // её пишет рантайм по вычисленному вердикту (6.7, хук `verdict` ниже), а не задним
  // числом Edit'ом. `Edit` в наборе остаётся ради обычной правки отчёта приёмки — см.
  // абзац про `RecordClaim`/`RecordFinding` ниже.
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
    {
      describe: 'отпечаток плана совпадает с текущими требованиями и уточнениями человека',
      check: (c) => planRequirementsProblem(c),
      artifact: (c) => c.paths.plan,
    },
    {
      describe: 'каждый ответ человека явно разрешён в одобренном плане',
      check: (c) => planClarificationProblem(c),
      artifact: (c) => c.paths.plan,
    },
    exists('журнал chunk’а на месте', (c) => c.paths.chunkJournal(c.chunk)),
    exists('патч попытки на месте', (c) => c.paths.chunkDiff(c.chunk, c.attempt)),
    exists('набор гейтов проекта на месте', (c) => c.paths.gates),
    granted(
      'место правки подтверждено человеком',
      (c) => c.paths.chunkJournal(c.chunk),
      DECISION.confirmed,
    ),
    // Восьмое условие вердикта — и на входе: переписанная задача не проверяется, а чинится.
    intentSectionsIntact('задача не переписана внутри витка (снимок секций intent.md)'),
  ],
  protectedArtifacts: RUNTIME_PROTECTED,
  humanGate: null,
  skipIf: null,
  evidence: (c) => [c.paths.chunkReviewText(c.chunk, c.attempt)],
  showsVerdict: true,
};

export const verifyModule: StageModule = {
  def: verifyStage,
  runtimeFacts: [{ id: 'preflight-gates', purpose: 'фактические результаты проверок до начала рецензирования', freshness: 'current-run' }],
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
      // Маршрут скана — `reviewScan`: отдельный `reviewModel` из конфига раннера либо
      // маршрут этапа verify. Рецензент, отличный от исполнителя, остаётся блокирующим;
      // скан той же моделью не пропускается, но его находки справочные (advisory) —
      // саморевью уровнем вердикта не является (норма verify, guided.md).
      const scan = host.reviewScan();
      const reviewText =
        scan.route.flow === 'loop' && scan.route.reviewFill
          ? await runReviewFill(host, scan.route, scan.blocking)
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
        (host.verifyState.reviewFillComplete || readGuided(host.paths) !== null);

      return {
        block: reviewText === null ? null : reviewerBlock(reviewText, scan.blocking),
        skip: skipModelTurn
          ? {
              ok: host.verifyState.reviewFillComplete,
              finalText: reviewText ?? '',
              usage: emptyUsage(),
              note:
                (host.verifyState.reviewFillComplete ? 'ход модели пропущен: reviewFill прошёл конвейер целиком — отчёт закрывается ' : 'reviewFill не завершён; guided не заменяет непроверенный JSON свободным ходом — отчёт закрывается ') +
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
      finishGuidedVerification(host);
    },

    // Дозаполнение отчёта приёмки по полям (замер r9: рецензенту 14B при лимите 40 не
    // хватало ходов именно на оформление отчёта). До ансамбля: дополнительные маршруты
    // снимают копию канонического отчёта, и она обязана быть полной.
    formFinish: () => readGuided(host.paths) ? null : ({
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
      // Свидетельства попытки — тоже факт рантайма: без `evidence.json` или с разошедшимися
      // хэшами патч и вывод тестов — текст исполнителя, и вердикт по ним не считается.
      host.verifyState.evidenceFact = attemptEvidenceFact(host);
      // Восьмое условие: задача против снимка секций — сверяет рантайм, не рецензент.
      host.verifyState.intentTamperFact = intentTamperedSections(host.ctx());
      // Ответ рецензента по контракту `verify-review-v1` — на диск, служебным файлом
      // попытки: терминальный `state_contract.py validate-review` читает его как есть.
      writeReviewJson(host);
      // Пишется только СВЕЖИЙ вердикт этого прогона: `verifyState.verdict` мог остаться от
      // прошлого прогона той же попытки, и при несостоявшемся расчёте (набор гейтов исчез)
      // он переписывался бы на диск как новый (code-review-all 2026-09-23).
      const fresh = host.computeStageVerdict(host.detectNoProgress());

      // Вердикт — на диск: подписанный служебный файл попытки (`verdictStore.ts`) решает
      // handoff, предусловие chunk, `/advance` и восстановление после рестарта; секция
      // «Вердикт» отчёта — копия для человека и терминальных скиллов. Модель пишет в отчёт
      // тоже, поэтому решений по отчёту рантайм не принимает. Прежний вердикт попытки на
      // входе НЕ снимается: отменённый повтор verify иначе оставлял попытку без вердикта, и
      // chunk перезаписывал её улики; от устаревания его страхует привязка к патчу.
      if (fresh !== null) {
        writeRunVerdict(host.paths, host.chunk(), host.attempt(), fresh);
        const reportPath = host.paths.verificationReport(host.chunk(), host.attempt());
        const report = readArtifact(reportPath);
        // Строки шапки «Сверка с деревом» и «Свидетельства попытки» — факты рантайма, а
        // не выбор модели из двух вариантов формы: вердикт по ним уже посчитан здесь же.
        const withFacts =
          report.exists
            ? writeEvidenceLines(report.text, {
                diffMatchesTree: host.verifyState.diffFactMatchesTree,
                evidenceProblem: host.verifyState.evidenceFact,
              })
            : null;
        const written = withFacts === null ? null : writeVerdictSection(withFacts.text, fresh);
        if (written !== null && (written.changed || withFacts!.changed)) host.writeAutofilled(reportPath, written.text, []);
        // Копия без строки `passed` — та же «не легла», даже если `action` поправлен.
        if (written === null || !written.found) {
          // Копия не легла — молча это не проходит: человек читает отчёт, а не служебный файл.
          host.emit({
            type: 'warning',
            runId: host.id,
            stage: 'verify',
            message:
              `вердикт не записан в отчёт приёмки ${reportPath}: нет секции «## Вердикт» с полями ` +
              '`passed`/`action` (модель изменила разметку?). Решения рантайма это не меняет — ' +
              'вердикт хранится в служебном файле попытки.',
          });
        }
      }

      // Колонка «Итог» журнала chunk'а — рантайм, не Edit модели (6.7): значение уже
      // посчитано строкой выше, дописывать его агентным ходом было бы тем же классом
      // работы, что и выдуманный `base_sha` плана. По возможности: журнала может не быть
      // (виток начат прямо с verify по снимку) — тогда просто нечего заполнять.
      if (fresh !== null) {
        const path = host.paths.chunkJournal(host.chunk());
        const journal = readArtifact(path);
        if (journal.exists) {
          const verdictOutcome = fresh.passed ? 'passed' : fresh.action;
          // Та же K после `blocked_env`: пометка среды в таблице попыток остаётся рядом с
          // новым исходом (`SDLC.md`: журнал отмечает такую попытку отдельной пометкой).
          const wasBlocked = new RegExp(`^\\|\\s*${host.attempt()}\\s*\\|.*blocked_env`, 'm').test(journal.text);
          const outcome = wasBlocked && verdictOutcome !== 'blocked_env' ? `blocked_env → ${verdictOutcome}` : verdictOutcome;
          const { text, filled } = autofillJournalOutcome(journal.text, host.attempt(), outcome);
          if (filled > 0) host.writeAutofilled(path, text, []);
        }
        // Строка «Сверка отчёта с набором» ставится автозаполнением зелёной ДО расчёта;
        // сама сверка — условие вердикта, и её провал обязан быть виден в той же строке.
        const missing = host.verifyState.lastVerdictInput?.enabledGatesMissingFromReport ?? [];
        if (missing.length > 0) {
          const rp = host.paths.verificationReport(host.chunk(), host.attempt());
          const cur = readArtifact(rp);
          if (cur.exists) {
            const fixed = writeGateRowStatus(cur.text, RECONCILE_GATE, '❌', `в отчёте нет строк включённых гейтов: ${missing.join(', ')}`);
            if (fixed.changed) host.writeAutofilled(rp, fixed.text, []);
          }
        }
      }
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

    // Кэш предыдущего pre-flight сбрасывается на входе: проба ниже (`entryBlocker`)
    // повторяется при каждом запуске, а устаревший результат прошлой попытки иначе висел бы
    // заметкой этапа (`Run.envNotes`) и после починки среды.
    resetOnEnter: () => {
      host.beginVerification();
      host.verifyState.lastPreflightBlockers = [];
    },

    // Рецензент, вызванный моделью через `Task`, проходит те же планки, что прямой прогон.
    // Ревью той же моделью, что исполнитель (маршрут этапа совпадает с chunk), — справочное:
    // находки принимаются advisory и вердикт не роняют (норма verify, guided.md).
    reviewAccepted: (text) => {
      const selfReview = routeKey(host.verifyRoute()) === routeKey(host.profile().routes.chunk);
      const accepted = acceptReviewText(host, text, 'Task', { advisory: selfReview });
      if (accepted.ok) return true;
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'verify',
        message: `вызов рецензента через Task: ответ не по контракту verify-review-v1 — ${accepted.why}. Гейт «${REVIEW_GATE}» остаётся ⏭`,
      });
      return false;
    },

    // Бессрочный принятый риск в «Долге» набора долг не открывает (`SDLC.md`), но и
    // пересматривать его некому — предупреждение в ленту на каждом входе в этап 6. Не
    // заметкой пробы среды: это проблема набора, и при запуске она не «повторится».
    afterStart: async () => {
      for (const d of host.gatesFile()?.debt ?? []) {
        if (!d.revisitMissing) continue;
        host.emit({
          type: 'warning',
          runId: host.id,
          stage: 'verify',
          message: `долг набора «${d.name}»: риск принят без условия «когда вернуться» — пересмотреть его будет некому`,
        });
      }
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
      // Исполнимость команд набора — тем же preflight'ом, что на входе chunk'а: среда могла
      // измениться между этапами, а неисполнимый гейт на этапе 6 — `blocked_env` ДО попытки.
      const gates = host.gatesFile();
      const gateBlockers = gates === null ? [] : await preflightGateBlockers(gates, host.projectRoot);
      const all = [...sandboxBlockers, ...gateBlockers];
      host.verifyState.lastPreflightBlockers = all;
      return all.length > 0 ? all.join('\n') : null;
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
