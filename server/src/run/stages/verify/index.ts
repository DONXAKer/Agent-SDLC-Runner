/** Этап 6 — верификация: определение этапа. */

import { DECISION } from '../../../artifacts/artifact.ts';
import { RUNTIME_PROTECTED, exists, granted } from '../preconditions.ts';
import type { StageDef } from '../types.ts';

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
