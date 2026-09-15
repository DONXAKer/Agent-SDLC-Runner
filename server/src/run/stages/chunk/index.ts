/** Этап 5 — chunk: определение этапа. */

import { DECISION } from '../../../artifacts/artifact.ts';
import { RUNTIME_PROTECTED, granted } from '../preconditions.ts';
import type { StageDef } from '../types.ts';

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
