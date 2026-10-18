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
 * прошла; иначе — `ContextProblem` с готовым сообщением оператору и признаком
 * `reloadable`. Решение о коде возврата (средовой класс, обычно 2) — за вызывающим.
 */

import { checkLmStudioContext } from './lmstudioContext.ts';
import { checkOllamaContext } from './ollamaContext.ts';
import { baseUrlFor } from './registry.ts';

export interface ContextProblem {
  message: string;
  /**
   * Дыру можно закрыть автоматической перезагрузкой движка (`--engine-reload`,
   * `bench/src/engine.ts::reloadEngine`) — модель не загружена, загружена не с тем окном
   * или не с тем числом parallel-слотов. `false` — реагировать нечем: неверный id
   * (LM Studio не видит модель вовсе) или Ollama, где окно зашито в тег, а не в загрузку.
   */
  reloadable: boolean;
}

export async function contextProblemFor(
  provider: string,
  modelId: string,
  contextWindow: number | undefined,
  providerBaseUrl: string | undefined,
): Promise<ContextProblem | null> {
  if (provider !== 'lmstudio' && provider !== 'ollama') return null;
  const baseUrl = baseUrlFor(provider) ?? providerBaseUrl;
  // Пустой/не заданный baseUrl — не наша забота: обычный путь запроса к провайдеру
  // упадёт своей, более точной ошибкой («не задан baseUrl»), дублировать её здесь незачем.
  if (baseUrl === undefined || baseUrl === '') return null;

  if (provider === 'lmstudio') {
    // Без заявленного окна сверять не с чем — LM Studio сообщит своей ошибкой по факту.
    if (contextWindow === undefined) return null;
    const r = await checkLmStudioContext(baseUrl, modelId, contextWindow);
    // `state === null` — модель не найдена в LM Studio вовсе (опечатка id): перезагрузка
    // не создаст то, чего нет в конфиге. Остальные красные состояния (не загружена,
    // загружена не с тем окном, parallel>1) чинятся `lms load` из reloadEngine.
    return r.ok ? null : { message: r.message, reloadable: r.state !== null };
  }

  // Ollama: проверяем и при незаявленном окне — ловушка голого тега (4096) красна сама
  // по себе, сверка с конфигом не нужна, чтобы её поймать.
  //
  // `skipped` — по адресу нет Ollama-шного `/api`: прокси с одним `/v1` (404), с ключом
  // только на `/v1` (401/403) или заглушка с не-JSON (`ollamaContext.ts::apiAbsent`).
  // Проверка неприменима, и блокировать ею прогон, который без неё работал, нельзя
  // (code-review, 2026-09-14: любой сбой `/api/tags` давал код 2). Сетевой отказ и таймаут
  // `skipped` НЕ дают: выключенный или зависший сервер — проблема, иначе преполёт зеленел
  // бы перед часами прогона. «Тег не найден» и «окно меньше заявленного» — тоже проблема:
  // там `/api` ответил, и ответ содержательный.
  const r = await checkOllamaContext(baseUrl, modelId, contextWindow);
  // Окно Ollama зашито в тег (`num_ctx` в Modelfile) — перезагрузка процесса не меняет
  // его никак; чинится только пересозданием тега, руками.
  return r.ok || r.skipped ? null : { message: r.message, reloadable: false };
}
