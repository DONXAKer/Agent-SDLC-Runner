/**
 * Публичный контракт пакета.
 *
 * Всё, что вызывают снаружи, проходит через этот файл. Внутренние модули друг на друга
 * ссылаются напрямую, но потребитель знает только отсюда.
 */

export { CATEGORY_LIMIT, limitFor } from './limits.ts';

export { FRAGILITY_FACTOR, volumetricWeightG } from './coef.ts';
export type { DimensionsCm } from './coef.ts';
