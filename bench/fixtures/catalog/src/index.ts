/**
 * Публичный контракт пакета.
 *
 * Всё, что вызывают снаружи, проходит через этот файл. Внутренние модули друг на друга
 * ссылаются напрямую, но потребитель знает только отсюда.
 */

export { product } from './product.ts';
export type { Product } from './product.ts';

export { loadAll, parse, saveAll, serialize } from './store.ts';
