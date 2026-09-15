/**
 * Этап 5 — chunk: определение этапа и механика журнала. Улики попытки —
 * `chunk/evidence.ts`, режим по шагам плана — `chunk/steps.ts`, восстановление номеров
 * chunk'а и попытки — `chunk/restore.ts`.
 */

import { DECISION, readArtifact, readDecision, writeArtifact } from '../../../artifacts/artifact.ts';
import { workingDiff } from '../../../gates/git.ts';
import { checkJournalClaimsVsBash } from '../../../verdict/honesty.ts';
import { autofillChunkJournal } from '../../journalAutofill.ts';
import { RUNTIME_PROTECTED, granted } from '../preconditions.ts';
import { ensureBaseline, recordEvidence } from './evidence.ts';
import type { SeededArtifact, StageDef, StageHost, StageModule } from '../types.ts';
import type { TreeChange } from '../../evidence.ts';

export const chunkStage: StageDef = {
  id: 'chunk',
  skill: 'sdlc-chunk',
  title: 'Chunk',
  tools: [
    'Read',
    'Glob',
    'Grep',
    'Write',
    'Edit',
    'Bash',
    'Task',
    'AskHuman',
    'FinalizeArtifact',
    'FillField',
    'RequestScopeExtension',
  ],
  // Точечная разведка места правки — read-only по построению.
  subagents: ['sdlc-locator'],
  // Патча и записи о тестах здесь НЕТ намеренно: их производит рантайм из фактического
  // дерева и фактического прогона (`run/evidence.ts`), а не исполнитель этапа. Пока они
  // стояли в этом списке, страж завершения требовал их от модели — то есть просил
  // составить улику о собственной работе, что она и делала: «PASS ✓» без единого запуска
  // тестов (`docs/model-runs.md`, этап 5). Проверка «этап что-то сделал» держится теперь
  // на журнале chunk'а и на непустом патче, а не на наличии файлов, которые кладём мы сами.
  produces: (c) => [c.paths.chunkJournal(c.chunk)],
  requires: [
    // Без заполненного поля одобрения chunk не начинается — так требует методология,
    // и проверяется именно поле в файле, а не память диалога.
    granted('план одобрен человеком', (c) => c.paths.plan, DECISION.approval),
  ],
  protectedArtifacts: RUNTIME_PROTECTED,
  humanGate: { artifact: 'journal', label: DECISION.confirmed },
  skipIf: null,
};

export const chunkModule: StageModule = {
  def: chunkStage,
  formFillExecutor: false,
  leanDocTools: false,
  checksBranchOnEntry: true,
  // Проактивное закрытие готового этапа — не на chunk: журнал попытки может стать готовым
  // раньше кода, и раннее закрытие обрубило бы дописывание правок в дереве.
  closeOnFinalizeReady: false,
  begin: (host, route) => {
    /** Рабочее дерево до этапа — база «дерево не изменилось» для улик попытки. */
    let diffBefore = '';
    return {
    // Снимок рабочего дерева ДО этапа: «дерево не изменилось» обязано считаться против
    // него, а не против HEAD. Коммита до этапа 7 не бывает, поэтому правки прошлой попытки
    // и прошлого chunk'а остаются в дереве, и сравнение с HEAD объявляло бы результативной
    // любую попытку после первой удачной.
    beforeSeed: async () => {
      diffBefore = await workingDiff(host.projectRoot, [], host.aborterSignal());
    },

    // Дозаполнение журнала chunk'а по полям (`ModelDef.formFill` у модели этапа 5):
    // серия r5 показала конструкционный провал — модель с идеальным кодом 7 прогонов
    // подряд не закрывала этап, дочищая журнал инструментами до конца лимита ходов.
    // Содержательные поля добираются per-field completion'ами тем же FormFillExecutor,
    // запись идёт через тот же гейт; этап закрывается ТОЛЬКО если исполнитель упал
    // именно на оформлении и после дозаполнения на диске всё на месте.
    formFinish: (result) => {
      // В режиме по шагам (`stepFill`) журнал chunk'а исполнитель не пишет по построению:
      // дозаполнение по полям идёт с отчётом о шагах во входе — иначе поля «что сделано»
      // заполнялись бы по памяти, которой у режима нет. Но только если хоть один шаг дал
      // правку: журнал этапа, в котором не записано ничего, не стоит двенадцати запросов —
      // он всё равно красный по дереву.
      const stepMode = route.stepFill;
      const stepProduced = stepMode && /применено [1-9]/.test(result.note);
      // Отчёт о шагах — артефакт попытки: причина красного шага иначе остаётся только в
      // консоли, и разбор прогона восстанавливает её по дереву (bench, stepfill-v2).
      if (stepMode && result.finalText !== '') {
        writeArtifact(host.paths.chunkSteps(host.chunk(), host.attempt()), `${result.finalText}\n`);
      }
      return {
        path: host.paths.chunkJournal(host.chunk()),
        forced: stepProduced,
        // Отчёт о шагах — второй блок промпта дозаполнения, которого нет в промпте из
        // `prompt_prepared`: как и блок рецензента, он факт рантайма, а не правка за спиной
        // оператора.
        extraBlock: stepProduced && result.finalText !== '' ? result.finalText : null,
        // `notDone` на chunk смотрит только журнал, и заполненный дозаполнением журнал
        // переворачивал бы в ok этап, упавший на лимите ходов с нетронутым кодом.
        requireCodeChange: true,
        // Правка кода — и по дереву, а не только по принятым Write/Edit: код правят и через
        // Bash и MCP-запись, и такой этап, упавший на оформлении при изменённом дереве,
        // оставался красным.
        treeChanged: async () => (await workingDiff(host.projectRoot, [], host.aborterSignal())) !== diffBefore,
      };
    },

    // Свидетельства попытки — патч и запись о тестах — производит рантайм, перезаписывая
    // то, что записал агент. Иначе вход этапа 6 остаётся рассказом исполнителя о самом
    // себе; замер поймал ровно этот случай (см. `evidence.ts`).
    evidence: async () => {
      host.chunkState.tree = await recordEvidence(host, diffBefore);

      // Честность доказательств: журнал утверждает «тесты прогнаны и прошли» — в ленте
      // обязан быть успешный bash-вызов команды тестов. Расхождение раньше было видно
      // только в отчёте бенчмарка после прогона; оператор витка обязан видеть его здесь,
      // до вердикта (порт щупа `bench/src/honesty.ts`).
      const journal = readArtifact(host.paths.chunkJournal(host.chunk()));
      if (journal.exists) {
        const honesty = checkJournalClaimsVsBash(
          journal.text,
          host.attemptToolEvents(),
          host.attemptObservedFromStart(),
        );
        if (honesty.ok === false) {
          host.emit({
            type: 'warning',
            runId: host.id,
            stage: 'chunk',
            message: `честность журнала: ${honesty.detail}`,
          });
        }
      }
    },

    // Пустое дерево после этапа 5 — самостоятельный провал, наравне с незаполненным
    // артефактом: свидетельства теперь кладёт рантайм, то есть «файлы на месте» перестало
    // быть признаком сделанной работы. `unknown` роняет этап по той же причине — состояние
    // дерева неизвестно, и считать его успехом значит зеленеть на непроверенном.
    outcomeProblem: (result) =>
      result.ok && host.chunkState.tree !== 'changed'
        ? host.chunkState.tree === 'empty'
          ? 'этап закончился, но дерево не изменилось: правки не было'
          : 'этап закончился, но состояние дерева неизвестно: свидетельства попытки не записаны'
        : null,

    // На этапе 5 прогресс — принятые записи в дерево: модель, повторившая вызов
    // рядом с делом, не должна терять уже записанный код.
    progress: (acceptedWrites) => ({
      progressSignal: acceptedWrites,
      // Без императива «Edit»: на задаче, где требуемое уже сделано, правка не
      // нужна вовсе, и совет по умолчанию толкал модель портить готовый код.
      progressHint:
        'если правка кода нужна — делай её сейчас инструментом Edit; если требуемое ' +
        'уже есть в коде — зафиксируй это в журнале и заверши этап.',
    }),

    afterStart: () => ensureBaseline(host),

    // Диагноз прошлой попытки — вход повторного chunk'а. Без него ретрай уходил тем же
    // промптом, что и первая попытка: причины красного посчитаны, но до исполнителя не
    // доезжали, и он заново угадывал, что именно не сошлось.
    enterFacts: async () => {
      const carried = host.carryForward();
      return carried === null ? [] : [carried];
    },

    autofill: (seeded) => autofillJournal(host, seeded),
    };
  },
};

/**
 * Механические поля журнала chunk'а (номер, base_sha, бюджет попыток, даты) заполняет
 * рантайм ДО модели: замер серии r2 показал, что слабая модель с идеальным кодом
 * сжигает лимит ходов ровно на этих полях. Снимок после подстановки уходит в
 * `SeededArtifact.snapshot` — страж «бланк байт-в-байт» сравнивает с ним, и этап,
 * не сделавший ничего, по-прежнему виден.
 *
 * Заполняет механические поля журнала chunk'а фактами рантайма — см. `journalAutofill.ts`.
 *
 * Идёт и на попытке K>1 (журнал уже существует и посеян не в этот раз): подстановка
 * идемпотентна, а незаполненные механические поля с прошлой попытки не должны съедать
 * ходы и этой. Снимок после подстановки кладётся в `SeededArtifact.snapshot`, чтобы
 * страж «бланк байт-в-байт» не ослеп от нашей же записи.
 */
export async function autofillJournal(host: StageHost, seeded: SeededArtifact[]): Promise<void> {
  const path = host.paths.chunkJournal(host.chunk());
  const journal = readArtifact(path);
  if (!journal.exists || journal.placeholders === 0) return;

  const baseSha = (await host.head()).sha;

  // Дата одобрения плана — только из фактического решения в plan.md: сочинять дату
  // решения человека нельзя, не извлеклась — поле остаётся плейсхолдером.
  let planApprovedOn: string | null = null;
  const plan = readArtifact(host.paths.plan);
  if (plan.exists) {
    const d = readDecision(plan.text, DECISION.approval);
    if (d.state === 'granted') {
      const m = /\d{4}-\d{2}-\d{2}|\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4}/.exec(
        ('raw' in d ? d.raw : undefined) ?? '',
      );
      planApprovedOn = m === null ? null : m[0];
    }
  }

  const { text, filled } = autofillChunkJournal(journal.text, {
    chunk: host.chunk(),
    slug: host.slug,
    date: new Date().toISOString().slice(0, 10),
    baseSha,
    attemptBudget: host.attemptBudget(),
    planApprovedOn,
  });
  if (filled === 0) return;

  host.writeAutofilled(path, text, seeded);
  host.emit({
    type: 'warning',
    runId: host.id,
    stage: 'chunk',
    message:
      `рантайм заполнил механические поля журнала (${filled}): номер, base_sha, бюджет, ` +
      'даты — модели остались содержательные',
  });
}

/** Состояние этапа 5 между вызовами. Владелец — виток (`Run.state.chunk`). */
export class ChunkState {
  /**
   * Что стало с деревом за последнюю попытку этапа 5.
   *
   * Три значения, а не булево: «не знаем» (запись улик упала) обязано отличаться от
   * «правки были», иначе попытка с неизвестным состоянием дерева проходит как нормальная —
   * ровно та дыра, ради закрытия которой улики и отобраны у агента.
   */
  tree: TreeChange = 'unknown';
}
