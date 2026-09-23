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

import { ENGINE_UNAVAILABLE_SUBSTRINGS, ProviderEnvError, ProviderHttpError } from '../../server/src/provider/ChatProvider.ts';
import { isLoopbackUrl } from '../../server/src/provider/http.ts';
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
  // HTTP-ответ провайдер уже классифицировал сам — по разобранному `error`, а не по сырому
  // телу (крах движка на 400 он отдаёт `ProviderEnvError`). Подстроки по тексту такой
  // ошибки ловили бы `fetch failed` из чужого сообщения в теле 400 и зря гоняли `lms load`
  // на общем GPU (code-review-all 2026-09-23). Узнаётся по типу, не по формату текста.
  if (e instanceof ProviderHttpError) return false;
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
  const timeoutMs = args.timeoutMs ?? WARMUP_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    await args.provider.chat({
      model: args.model,
      messages: [{ role: 'user', content: 'Ответь одним словом: готов.' }],
      tools: [],
      signal,
      temperature: null,
      params: { ...(args.params ?? {}), max_tokens: WARMUP_MAX_TOKENS },
    });
  } catch (e) {
    // Свой потолок прогрева приходит в провайдер как `req.signal`, и тот честно бросает
    // «запрос отменён» — не `ProviderEnvError`: зависший или долго грузящийся движок
    // выглядел отменой оператора, и `--engine-reload` на нём не срабатывал
    // (code-review-all 2026-09-23). Неответ за потолок прогрева — сбой движка.
    if (signal.aborted) {
      throw new ProviderEnvError(`движок не ответил на прогрев за ${timeoutMs} мс`, { cause: e });
    }
    throw e;
  }
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

/** Сколько ждать закрытия stdio после выхода процесса, прежде чем перестать ждать. */
const STDIO_GRACE_MS = 2_000;

/**
 * Произвольная команда с потолком стенных часов. `spawnNode` (`nodeTest.ts`) не подходит:
 * он жёстко спавнит `process.execPath` — node, а здесь нужен внешний бинарь (`lms`).
 * Шелл не подключается: имя модели приходит из конфига, и через `shell: true` оно стало бы
 * интерполяцией в командную строку.
 *
 * Исход решается не только по 'close': оно ждёт закрытия stdio, а `lms` может поднять
 * демон LM Studio, унаследовавший пайпы, — тогда 'close' не приходит никогда, и преполёт
 * висел бы вечно (code-review-all 2026-09-23). Поэтому — 'exit' с короткой форой на
 * дочитывание вывода, а по таймауту — снятие дерева процессов и немедленный исход.
 */
function runCmd(cmd: string, args: readonly string[], timeoutMs: number): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { windowsHide: true });
    const out: string[] = [];
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const settle = (r: Omit<CmdResult, 'output'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      resolve({ ...r, output: out.join('').trim() });
    };
    child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    const timer = setTimeout(() => {
      killTree(child.pid);
      child.kill();
      settle({ exitCode: null, notFound: false, timedOut: true });
    }, timeoutMs);
    child.on('exit', (code) => {
      grace = setTimeout(() => settle({ exitCode: code, notFound: false, timedOut: false }), STDIO_GRACE_MS);
    });
    child.on('close', (code) => settle({ exitCode: code, notFound: false, timedOut: false }));
    child.on('error', () => {
      // ENOENT — команды нет в PATH. Текст ошибки ОС («spawn lms ENOENT») оператору
      // ни о чём не говорит — сводим к флагу notFound, формулировка выше по стеку.
      settle({ exitCode: null, notFound: true, timedOut: false });
    });
  });
}

/** На Windows `kill()` снимает только сам процесс, не его потомков — дерево гасит taskkill. */
function killTree(pid: number | undefined): void {
  if (pid === undefined || process.platform !== 'win32') return;
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  } catch {
    // Снять дерево не удалось — остаётся `child.kill()` вызывающего.
  }
}

/**
 * Перезагрузка модели при средовом сбое движка. Вызывается ТОЛЬКО за явным флагом
 * оператора (`--engine-reload`, проверяет преполёт): GPU общий, и молча дёргать загрузку
 * моделей нельзя.
 *
 * Команды по провайдерам:
 * - LM Studio — `lms unload <модель>` и `lms load <модель> -c <окно> --parallel 1 -y`:
 *   упавший движок поднимается только перезагрузкой. Окно и один слот — ровно те, что
 *   требует проверка окна преполёта (`checkLmStudioContext`): голый `lms load` поднимал
 *   модель с окном и `--parallel` по умолчанию (класс test22), выгрузка перед загрузкой не
 *   даёт поднять второй экземпляр `:2`, а `-y` — зависнуть на интерактивном выборе
 *   (code-review-all 2026-09-23). Наличие CLI проверяется дешёвым `lms --version`;
 * - ollama — отдельной команды НЕТ: движок сам поднимает модель на повторном запросе,
 *   поэтому «перезагрузка» — сам повтор пробы (`ollama pull` качал бы веса заново и не
 *   нужен);
 * - остальные — осмысленной команды нет, честный `unsupported` вместо молчаливого ретрая.
 */
export async function reloadEngine(args: {
  provider: string;
  model: string;
  /** Адрес сервера модели: `lms` управляет только ЛОКАЛЬНЫМ LM Studio. */
  baseUrl?: string;
  /** Окно из конфига модели (`ModelDef.contextWindow`); без него `lms` берёт своё умолчание. */
  contextWindow?: number;
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
  // `lms` перезагружает модель на ЭТОЙ машине. Сервер за удалённым `LMSTUDIO_BASE_URL`
  // так не поднять, а локальный общий GPU получил бы загрузку, которую никто не просил.
  if (args.baseUrl !== undefined && !isLoopbackUrl(args.baseUrl)) {
    return {
      kind: 'unsupported',
      detail: `сервер LM Studio не локальный (${args.baseUrl}) — lms перезагружает только модели этой машины, перезагрузите движок вручную`,
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
  // Исход выгрузки не важен: модели может и не быть в памяти (движок лёг вместе с ней).
  await runCmd('lms', ['unload', args.model], 60_000);
  const loadArgs = [
    'load',
    args.model,
    ...(args.contextWindow === undefined ? [] : ['-c', String(args.contextWindow)]),
    '--parallel',
    '1',
    '-y',
  ];
  const shown = `lms ${loadArgs.join(' ')}`;
  const r = await runCmd('lms', loadArgs, timeoutMs);
  if (r.timedOut) {
    return { kind: 'failed', detail: `${shown} снят по таймауту ${timeoutMs} мс` };
  }
  if (r.exitCode !== 0) {
    return { kind: 'failed', detail: `${shown} завершился кодом ${r.exitCode}: ${r.output.slice(0, 200)}` };
  }
  return { kind: 'reloaded', detail: `${shown} зелёный` };
}
