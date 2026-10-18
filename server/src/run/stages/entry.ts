/**
 * Вход этапа: всё, что не пускает этап стартовать, с этапом-виновником каждой причины.
 *
 * Вынесено из `Run.blockerDetails` чистой функцией от `StageContext` и набора гейтов:
 * дашборд считает блокеры архивных витков по диску и не вправе поднимать `Run` (конструктор
 * пишет `.runner/.gitignore` в каталог витка). Живой `Run` зовёт ту же функцию — второе
 * место решения «почему этап не стартует» разошлось бы с первым при первой же правке.
 */

import type { StageId } from '@sdlc-runner/shared';

import { readArtifact } from '../../artifacts/artifact.ts';
import { approvedPreparationProblem } from '../../artifacts/preparation.ts';
import { extractFilesToTouch } from '../../artifacts/planFiles.ts';
import { builtinFor } from '../../gates/builtin/index.ts';
import { configProblems, unimplementedGates } from '../../gates/gatesFile.ts';
import type { GatesFile } from '../../gates/gatesFile.ts';
import { checkPreconditions, stageById, stageProducing } from './index.ts';
import type { PreconditionReport, StageContext } from './types.ts';
import { UNSCRIPTED_GATES } from './verify/gates.ts';

/** Этапы, после которых запись ограничена одобренным планом. */
const PLAN_SCOPED_STAGES: readonly StageId[] = ['chunk', 'verify', 'handoff'];

/**
 * Список файлов, в которые разрешена запись, либо `null` — PlanScope выключен.
 *
 * Пустой список при существующем плане — не «разрешено всё», а дефект: так PlanScope
 * выключился бы молча. Такой виток не продолжается (см. `entryProblems`).
 */
export function planFilesOnDisk(ctx: StageContext, stage: StageId): readonly string[] | null {
  if (!PLAN_SCOPED_STAGES.includes(stage)) return null;
  const plan = readArtifact(ctx.paths.plan);
  if (!plan.exists) return null;
  return extractFilesToTouch(plan.text);
}

export interface EntryProblem {
  text: string;
  blamed: StageId | null;
}

/**
 * Причины, по которым этап не стартует. `blamed` — чей артефакт завалил вход; `null` —
 * причина не про артефакт прошлого этапа (недостающее решение человека) либо виновник не
 * запрошен (`withBlame: false` — GET-опрос витка его не показывает и экономит чтение).
 * Виновник выводится `stageProducing` из пути артефакта — второе место решения «кто
 * виноват» разошлось бы с `produces` этапов при первой их правке.
 */
export function entryProblems(
  stage: StageId,
  ctx: StageContext,
  gates: GatesFile | null,
  opts: { abortHandoff?: boolean; withBlame?: boolean; precomputed?: PreconditionReport } = {},
): EntryProblem[] {
  const withBlame = opts.withBlame ?? true;
  const abortHandoff = opts.abortHandoff === true;
  const report =
    opts.precomputed ??
    checkPreconditions(stageById(stage), ctx, { ...(abortHandoff ? { abortHandoff } : {}), withArtifacts: withBlame });
  const blame = (path: string | null): StageId | null =>
    withBlame && path !== null ? stageProducing(path, stage, ctx) : null;
  const problems: EntryProblem[] = report.details.map((d) => ({
    text: d.text,
    blamed: withBlame && d.blamed !== undefined ? d.blamed : blame(d.artifact),
  }));
  const by = (blamed: StageId | null) => (text: string): EntryProblem => ({ text, blamed });

  if (PLAN_SCOPED_STAGES.includes(stage)) {
    if (!abortHandoff) {
      const problem = approvedPreparationProblem(ctx.paths);
      if (problem !== null) problems.push({ text: problem, blamed: withBlame ? 'plan' : null });
    }
    const files = planFilesOnDisk(ctx, stage);
    if (files !== null && files.length === 0) {
      problems.push(
        by(blame(ctx.paths.plan))(
          `план ${ctx.paths.plan} есть, но files_to_touch пуст: PlanScope выключился бы молча, ` +
            `и запись перестала бы быть ограниченной планом. Заполни секцию files_to_touch.`,
        ),
      );
    }
  }

  // Обязательная пятёрка проверяется на старте КАЖДОГО этапа, кроме первого: именно
  // на первом набор и собирают. Проверять её только на этапе 6 значило бы узнавать
  // о несобранном наборе, потратив весь виток.
  //
  // Объявленный обрыв витка из-под этой проверки выведен намеренно: handoff при обрыве —
  // единственный способ оставить запись о том, почему виток бросили, и запирать его
  // тем же несобранным набором значило бы лишить виток последнего легального выхода.
  if (stage !== 'intent' && !(stage === 'handoff' && abortHandoff)) {
    const gatesBlame = blame(ctx.paths.gates);
    if (gates === null) {
      problems.push(
        by(gatesBlame)(
          `нет набора гейтов ${ctx.paths.gates}. Без него не определены ни «сделано», ни ` +
            `условия вердикта — виток не стартует.`,
        ),
      );
    } else {
      problems.push(...configProblems(gates).map(by(gatesBlame)));
      // Гейты без скрипта (`UNSCRIPTED_GATES`: ревью, сверка отчёта с набором, гейты
      // проверяющего) НЕ являются дырой в наборе: статус ревью ставит
      // `externalGateStatuses()`, прочих — отчёт (`verify/gates.ts::reportedBy`), тем же
      // путём, каким он и считается на прогоне. Без этого исключения витки с обычным для
      // минимума набором никогда бы не проходили дальше intent.
      problems.push(
        ...unimplementedGates(gates, (name) => builtinFor(name) !== null, UNSCRIPTED_GATES).map(by(gatesBlame)),
      );
    }
  }

  return problems;
}
