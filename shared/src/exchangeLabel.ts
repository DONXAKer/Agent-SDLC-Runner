/**
 * Метка исхода ОДНОГО обмена «промпт → ответ модели» для корпуса дообучения
 * (`docs/model-tuning.md`) — пишется рантаймом (`server/src/provider/rawLog.ts::
 * annotateExchange`) рядом с сырым дампом (`<путь дампа>.label.json`), читается сборщиком
 * корпуса (`bench/src/corpus.ts`).
 *
 * Общий тип, а не по `Record<string, unknown>` на каждой стороне, — единственная защита
 * от того, чтобы писатель (шесть мест: `LoopExecutor`, `StepExecutor`, `FormFillExecutor`
 * — оба пути, `claimFill`, `reviewFill`, `planAxisFill`/`planAxisStepwise`) и читатель
 * молча разошлись в имени поля: переименование в одном месте без общего типа проходило
 * бы `tsc --noEmit` без единой ошибки (code-review-all, 2026-09-27). Живёт в `shared`, а
 * не в `server`: `bench` не тянет `server` как зависимость, а `@sdlc-runner/shared` уже
 * используют обе стороны.
 */
export interface ExchangeLabel {
  /** Принят ли обмен механическим оракулом — единственное поле, которое проверяет сборщик корпуса. */
  accepted?: boolean;
  /** Имя оракула, вынесшего вердикт (`step-check`, `claims-minimum`, `apply-fill`, …). */
  oracle?: string;
  /** Мишень корпуса, которой соответствует обмен (`form-field`, `plan-step`, `claim-fill`, …). */
  target?: string;
  /** Причина исхода — machine-readable ключ (`accepted`, `empty-or-placeholder`, …). */
  reason?: string;
  /**
   * Причины трения хода (`LoopExecutor.friction`) — НАКАПЛИВАЮТСЯ при повторной разметке
   * того же обмена (несколько вызовов инструментов одного хода делят один обмен модели),
   * а не заменяют друг друга: `annotateExchange` мержит массивы этого поля между вызовами
   * (см. её докстринг) — иначе трение второго вызова хода стирало бы трение первого молча
   * (code-review-all, 2026-09-27). У режима `loop` `accepted` не пишется вовсе: он не входит
   * в обучаемые режимы корпуса (`bench/src/corpus.ts::TRAINABLE_MODES`), метка здесь
   * исключительно диагностическая.
   */
  frictions?: string[];
}
