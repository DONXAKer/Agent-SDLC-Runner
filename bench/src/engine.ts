/**
 * Обвязка движка — прогрев и автоперезагрузка (§2.1 п.4
 * docs/proposals/model-flow-improvements.md).
 *
 * Зачем: холодный движок (LM Studio / ollama) поднимает веса на ПЕРВОМ запросе, и без
 * прогрева этот холодный старт ложился в первую замеряемую пробу преполёта — клетка мерила
 * движок, а не модель (§1.2). Лёгший движок (`HTTP 400 terminated`, `fetch failed`) раньше
 * требовал ручной перезагрузки посреди ночной серии; за явным флагом оператора преполёт
 * делает это сам — один раз.
 *
 * Классификация сбоев здесь НЕ дублируется: матчер и тип ошибки импортируются из
 * провайдера (`ChatProvider.ts`) — два регэкспа с одними подстроками уже расходились однажды
 * (code-review, 2026-09-14).
 */

import { spawn } from 'node:child_process';

import { ENGINE_UNAVAILABLE_SUBSTRINGS, ProviderEnvError } from '../../server/src/provider/ChatProvider.ts';
import type { ChatProvider } from '../../server/src/provider/ChatProvider.ts';

/**
 * Ответ прогрева не используется — меряется поднятие весов, а не генерация, поэтому
 * ответ обрезается первым же токеном. Конфиг модели может нести свой `max_tokens`
 * (4096 и больше) — прогрев перекрывает его, иначе «дешёвый запрос» стоил бы как кейс пробы.
 */
export const WARMUP_MAX_TOKENS = 1;

/**
 * Холодная загрузка крупной модели — минуты, поэтому потолок прогрева совпадает с потолком
 * кейса пробы (PROBE_CASE_TIMEOUT_MS), а не с «секундами» скрининга.
 */
export const WARMUP_TIMEOUT_MS = 120_000;

/** `lms load` крупной модели на общем GPU — минуты; отдельный потолок от прогрева. */
export const ENGINE_RELOAD_TIMEOUT_MS = 300_000;

/**
 * Средовой сбой движка — та же классификация, что у провайдера: `ProviderEnvError`
 * (5xx/429/таймаут/обрыв) либо подстроки живого падения движка в тексте ошибки.
 * Обёртка нужна, потому что прогрев ловит ошибку напрямую из `chat`, а не из разобранного
 * тела HTTP-ответа, — но правило одно, и живёт оно в `ChatProvider.ts`.
 */
export function isEngineEnvFailure(e: unknown): boolean {
  if (e instanceof ProviderEnvError) return true;
  const message = e instanceof Error ? e.message : String(e);
  return ENGINE_UNAVAILABLE_SUBSTRINGS.test(message);
}

/**
 * Один дешёвый запрос ДО замеряемых проб: холодный движок поднимает веса на первом
 * вызове. Ответ не читается — любой успешный ответ означает «движок тёплый»; ошибку
 * классифицирует вызывающий (`isEngineEnvFailure`). Промпт короткий, инструментов нет,
 * `max_tokens` минимальный — прогрев обязан стоить заметно дешевле любого кейса пробы.
 */
export async function warmupEngine(args: {
  provider: ChatProvider;
  model: string;
  params: Record<string, unknown> | null;
  timeoutMs?: number;
}): Promise<void> {
  await args.provider.chat({
    model: args.model,
    messages: [{ role: 'user', content: 'Ответь одним словом: готов.' }],
    tools: [],
    signal: AbortSignal.timeout(args.timeoutMs ?? WARMUP_TIMEOUT_MS),
    temperature: null,
    params: { ...(args.params ?? {}), max_tokens: WARMUP_MAX_TOKENS },
  });
}

/** Исход попытки перезагрузки: от него зависит, есть ли смысл в повторе срезавшейся пробы. */
export type EngineReloadOutcome =
  /** Команда выполнена (`lms load`) или не нужна (ollama) — повтор пробы имеет смысл. */
  | { kind: 'reloaded'; detail: string }
  /** Осмысленной команды у провайдера нет — повтор бессмыслен, флаг честно говорит об этом. */
  | { kind: 'unsupported'; detail: string }
  /** Команда была, но завершилась ошибкой — повтор не делаем. */
  | { kind: 'failed'; detail: string };

interface CmdResult {
  /** `null` — процесс не запустился (команды нет в PATH) или снят по таймауту. */
  exitCode: number | null;
  output: string;
  notFound: boolean;
  timedOut: boolean;
}

/**
 * Произвольная команда с потолком стенных часов. `spawnNode` (`nodeTest.ts`) не подходит:
 * он жёстко спавнит `process.execPath` — node, а здесь нужен внешний бинарь (`lms`).
 * Шелл не подключается: имя модели приходит из конфига, и через `shell: true` оно стало бы
 * интерполяцией в командную строку.
 */
function runCmd(cmd: string, args: readonly string[], timeoutMs: number): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { windowsHide: true });
    const out: string[] = [];
    let notFound = false;
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output: out.join('').trim(), notFound, timedOut });
    });
    child.on('error', () => {
      // ENOENT — команды нет в PATH. Текст ошибки ОС («spawn lms ENOENT») оператору
      // ни о чём не говорит — сводим к флагу notFound, формулировка выше по стеку.
      clearTimeout(timer);
      notFound = true;
      resolve({ exitCode: null, output: '', notFound, timedOut });
    });
  });
}

/**
 * Перезагрузка модели при средовом сбое движка. Вызывается ТОЛЬКО за явным флагом
 * оператора (`--engine-reload`, проверяет преполёт): GPU общий, и молча дёргать загрузку
 * моделей нельзя.
 *
 * Команды по провайдерам:
 * - LM Studio — `lms load <модель>`: упавший движок поднимается только перезагрузкой;
 *   наличие CLI проверяется дешёвым `lms --version`, без sudo и без самой загрузки;
 * - ollama — отдельной команды НЕТ: движок сам поднимает модель на повторном запросе,
 *   поэтому «перезагрузка» — сам повтор пробы (`ollama pull` качал бы веса заново и не
 *   нужен);
 * - остальные — осмысленной команды нет, честный `unsupported` вместо молчаливого ретрая.
 */
export async function reloadEngine(args: {
  provider: string;
  model: string;
  timeoutMs?: number;
}): Promise<EngineReloadOutcome> {
  if (args.provider === 'ollama') {
    return {
      kind: 'reloaded',
      detail: 'ollama поднимает модель сам на следующем запросе — отдельная команда перезагрузки не нужна',
    };
  }
  if (args.provider !== 'lmstudio') {
    return {
      kind: 'unsupported',
      detail: `автоперезагрузка для провайдера «${args.provider}» не поддержана: осмысленной команды нет — перезагрузите движок вручную`,
    };
  }
  const version = await runCmd('lms', ['--version'], 15_000);
  if (version.notFound || version.exitCode !== 0) {
    return {
      kind: 'unsupported',
      detail: 'команда lms не найдена в PATH — автоперезагрузка LM Studio недоступна, загрузите модель вручную',
    };
  }
  const timeoutMs = args.timeoutMs ?? ENGINE_RELOAD_TIMEOUT_MS;
  const r = await runCmd('lms', ['load', args.model], timeoutMs);
  if (r.timedOut) {
    return { kind: 'failed', detail: `lms load ${args.model} снят по таймауту ${timeoutMs} мс` };
  }
  if (r.exitCode !== 0) {
    return { kind: 'failed', detail: `lms load ${args.model} завершился кодом ${r.exitCode}: ${r.output.slice(0, 200)}` };
  }
  return { kind: 'reloaded', detail: `lms load ${args.model} зелёный` };
}
