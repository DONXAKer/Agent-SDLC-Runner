/**
 * Классификация "AbortError: Stream closed" во флоу `sdk` (A2 ретроспективы AUTH-104).
 *
 * Наблюдение живого витка: этап verify падал `AbortError` ("Stream closed") без единого
 * события в шину — `req.signal` не был взведён (оператор ничего не отменял), но
 * `SdkExecutor.run()` всё равно ловил `req.signal.aborted === false` и перебрасывал
 * исключение необработанным, обрывая прогон без диагностики. `isSdkTransportAbort`
 * отделяет этот класс ошибок SDK от обычных исключений, которые всё ещё обязаны падать
 * дальше — интеграционный тест на сам `SdkExecutor.run()` здесь не заводится: `query()`
 * приходит из живого SDK, мокать его на уровне модуля в этом рантайме нечем; классификация
 * — единственная часть находки, которая проверяется без него.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isSdkTransportAbort } from '../src/exec/SdkExecutor.ts';

describe('isSdkTransportAbort: разрыв канала SDK vs обычная ошибка', () => {
  it('DOMException AbortError — канал SDK, не обычная ошибка', () => {
    strictEqual(isSdkTransportAbort(new DOMException('Stream closed', 'AbortError')), true);
  });

  it('обычная ошибка с текстом про поток, но другим именем — не AbortError', () => {
    strictEqual(isSdkTransportAbort(new Error('stream closed unexpectedly')), false);
  });

  it('TypeError и прочие штатные исключения проходят как есть, не глотаются', () => {
    strictEqual(isSdkTransportAbort(new TypeError('unexpected input')), false);
  });

  it('не-Error значения (строка, undefined, null) — не AbortError', () => {
    strictEqual(isSdkTransportAbort('AbortError'), false);
    strictEqual(isSdkTransportAbort(undefined), false);
    strictEqual(isSdkTransportAbort(null), false);
  });
});
