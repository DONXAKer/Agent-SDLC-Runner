/**
 * Публичный контракт пакета.
 *
 * Всё, что вызывают снаружи, проходит через этот файл. Внутренние модули друг на друга
 * ссылаются напрямую, но потребитель знает только отсюда.
 */

export { fixedClock, instantOf, systemClock } from './clock.ts';
export type { Clock } from './clock.ts';

export { overlaps } from './slots.ts';
export type { Slot } from './slots.ts';

export { isActive, makeHold } from './hold.ts';
export type { Hold } from './hold.ts';

export { WAREHOUSES } from './warehouse.ts';
export type { Warehouse } from './warehouse.ts';
