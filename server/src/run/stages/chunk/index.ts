/**
 * Этап 5 — chunk: определение этапа и механика журнала. Улики попытки —
 * `chunk/evidence.ts`, режим по шагам плана — `chunk/steps.ts`, восстановление номеров
 * chunk'а и попытки — `chunk/restore.ts`.
 */

import { DECISION, readArtifact, readDecision } from '../../../artifacts/artifact.ts';
import { autofillChunkJournal } from '../../journalAutofill.ts';
import { RUNTIME_PROTECTED, granted } from '../preconditions.ts';
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
};

/**
 * Механические поля журнала chunk'а (номер, base_sha, бюджет попыток, даты) заполняет
 * рантайм ДО модели: замер серии r2 показал, что слабая модель с идеальным кодом
 * сжигает лимит ходов ровно на этих полях. Снимок после подстановки уходит в
 * `SeededArtifact.snapshot` — страж «бланк байт-в-байт» сравнивает с ним, и этап,
 * не сделавший ничего, по-прежнему виден.
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
