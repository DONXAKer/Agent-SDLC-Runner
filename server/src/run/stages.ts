/**
 * Декларация семи этапов витка.
 *
 * Три принципа методологии зашиты здесь конструкцией:
 *
 * - «Права выдаются на шаг, а не на прогон» — у каждого этапа свой набор инструментов,
 *   и политика отклоняет всё, что в него не входит.
 * - «Нет артефакта — нет шага» — предусловия проверяются чтением файлов, а не памятью
 *   диалога. Виток, начатый в терминале скиллами `/sdlc-*`, продолжается здесь и наоборот.
 * - «Автор не рецензирует себя» — рецензент этапа 6 получает артефакты и diff, но не
 *   журнал исполнителя: журнал это и есть рассказ о том, как шла работа.
 *
 * Декларация разнесена по модулям `stages/**` — файл на этап. Этот файл — фасад: прежние
 * импорты `run/stages.ts` продолжают работать, новых сюда не добавлять.
 */

export type { Precondition, PreconditionOptions, PreconditionProblem, PreconditionReport, StageContext, StageDef, StageInput } from './stages/types.ts';
export { hasOpenQuestions, isSmallContour, relOf } from './stages/preconditions.ts';
export { stageInputs } from './stages/inputs.ts';
export { intentPlaceholderProblem } from './stages/intent.ts';
export { declaredAsNew, explorationPathProblem } from './stages/explore.ts';
export { filesToTouchProblem } from './stages/plan.ts';
export { STAGES, checkPreconditions, isStageId, stageById, stageProducing } from './stages/index.ts';
