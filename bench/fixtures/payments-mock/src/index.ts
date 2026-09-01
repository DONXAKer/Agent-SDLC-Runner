/**
 * Публичный контракт пакета.
 *
 * Всё, что вызывают снаружи, проходит через этот файл. Внутренние модули друг на друга
 * ссылаются напрямую, но потребитель знает только отсюда.
 */

export { mockBank } from './mock.ts';
export type { HttpPost, HttpResponse } from './transport.ts';
export type { ChargeRequest, ChargeResult } from './client.ts';

// `charge` здесь намеренно не реэкспортируется: реализации в client.ts пока нет, и реэкспорт
// несуществующего имени ронял бы загрузку модуля на линковке.
