/**
 * Публичный контракт пакета: снаружи импортируют только этот файл.
 *
 * Внутренние модули могут переезжать и переименовываться — потребители отчёта этого видеть
 * не должны.
 */

export type { SaleRow } from './rows.ts';
export type { ManagerTotal } from './aggregate.ts';
export { aggregate, THRESHOLD_K } from './aggregate.ts';
export { renderReport } from './report.ts';
