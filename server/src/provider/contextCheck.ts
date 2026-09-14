/**
 * Диспетчер преполётной проверки окна контекста по провайдеру.
 *
 * Раньше проверялся только LM Studio (`lmstudioContext.ts`): расхождение между
 * заявленным в конфиге окном и фактическим обнаруживалось посреди дорогого прогона.
 * У Ollama своя, не менее дорогая ловушка — голый тег молча даёт 4096 токенов
 * (`ollamaContext.ts`), и до появления этого диспетчера её не проверял никто.
 *
 * Одна функция на обоих потребителей — живая прогонка бенчмарка и преполётный
 * `--preflight`: копии такой обвязки уже успели разойтись потолком кейса пробы
 * (см. `resolveProbeTarget` в probe.ts), повторять тот же приём не надо.
 *
 * Возвращает `null` — проверка не применима (провайдер без управляемого окна) либо
 * прошла; непустую строку — готовое сообщение оператору, почему прогон не стоит
 * начинать. Решение о коде возврата (средовой класс, обычно 2) — за вызывающим.
 */

import { checkLmStudioContext } from './lmstudioContext.ts';
import { checkOllamaContext } from './ollamaContext.ts';
import { baseUrlFor } from './registry.ts';

export async function contextProblemFor(
  provider: string,
  modelId: string,
  contextWindow: number | undefined,
  providerBaseUrl: string | undefined,
): Promise<string | null> {
  if (provider !== 'lmstudio' && provider !== 'ollama') return null;
  const baseUrl = baseUrlFor(provider) ?? providerBaseUrl;
  // Пустой/не заданный baseUrl — не наша забота: обычный путь запроса к провайдеру
  // упадёт своей, более точной ошибкой («не задан baseUrl»), дублировать её здесь незачем.
  if (baseUrl === undefined || baseUrl === '') return null;

  if (provider === 'lmstudio') {
    // Без заявленного окна сверять не с чем — LM Studio сообщит своей ошибкой по факту.
    if (contextWindow === undefined) return null;
    const r = await checkLmStudioContext(baseUrl, modelId, contextWindow);
    return r.ok ? null : r.message;
  }

  // Ollama: проверяем и при незаявленном окне — ловушка голого тега (4096) красна сама
  // по себе, сверка с конфигом не нужна, чтобы её поймать.
  //
  // `skipped` — по адресу нет Ollama-шного `/api` (прокси только с `/v1`, сервер молчит):
  // проверка неприменима, и блокировать ею прогон, который без неё работал, нельзя
  // (code-review, 2026-09-14: любой сбой `/api/tags` давал код 2). Недоступный сервер
  // назовёт обычный путь запроса — своей средовой ошибкой. «Тег не найден» и «окно меньше
  // заявленного» по-прежнему проблема: там `/api` ответил, и ответ содержательный.
  const r = await checkOllamaContext(baseUrl, modelId, contextWindow);
  return r.ok || r.skipped ? null : r.message;
}
