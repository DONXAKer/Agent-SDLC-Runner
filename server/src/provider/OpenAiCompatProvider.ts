/**
 * Один класс на Ollama / vLLM / LM Studio / OpenRouter / AITunnel.
 *
 * Все они говорят на `/v1/chat/completions` с полем `tools` — различия сводятся к базовому
 * адресу и ключу, и заводить под каждый свой класс значило бы четыре раза повторить один
 * разбор ответа.
 *
 * Что здесь неочевидно и стоило отладки в AI-Workflow:
 *
 *  - **`tool_calls` приходят не только объектом.** Часть серверов отдаёт `arguments`
 *    строкой JSON, часть — уже объектом; 4B-модели периодически отдают сломанный JSON.
 *    Разбор терпимый: не разобралось — цикл скажет модели об этом, а не упадёт.
 *  - **Локальная модель любит написать вызов текстом.** Если `tool_calls` пусто, но в
 *    тексте лежит JSON с именем известного инструмента, он вытаскивается оттуда. Без
 *    этого 4B-класс выглядит «сломанным», хотя намерение выражено однозначно.
 *  - **Стоимости у локального маршрута нет.** Это `null`, а не ноль: ноль означал бы
 *    «посчитали и вышло даром».
 */

import http from 'node:http';
import https from 'node:https';

import type { Usage } from '@sdlc-runner/shared';
import { emptyUsage } from '@sdlc-runner/shared';

import type {
  ChatProvider,
  ChatRequest,
  ChatToolCall,
  ChatTurn,
  FinishReason,
} from './ChatProvider.ts';

interface OpenAiChoice {
  message?: {
    content?: string | null;
    tool_calls?: {
      id?: string;
      function?: { name?: string; arguments?: unknown };
    }[];
  };
  finish_reason?: string;
}

interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    /** Расширение OpenRouter: фактическая стоимость запроса. У локальных серверов его нет. */
    cost?: number;
  };
  error?: { message?: string };
}

export interface OpenAiCompatOptions {
  name: string;
  baseUrl: string;
  apiKey: string | null;
  timeoutMs: number;
}

function parseArguments(raw: unknown): { args: Record<string, unknown> | null; text: string } {
  if (typeof raw === 'object' && raw !== null) {
    return { args: raw as Record<string, unknown>, text: JSON.stringify(raw) };
  }
  const text = typeof raw === 'string' ? raw : '';
  if (text.trim() === '') return { args: {}, text };
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? { args: parsed as Record<string, unknown>, text }
      : { args: null, text };
  } catch {
    return { args: null, text };
  }
}

/**
 * Причина завершения хода.
 *
 * `length` не затирается наличием вызовов: обрезанный по лимиту токенов ход отдаёт
 * вызов с оборванной строкой аргументов, и пока `hasCalls` побеждал безусловно, цикл
 * диагностировал «сломанный JSON» и «прогресса нет» вместо настоящей причины.
 */
function mapFinish(reason: string | undefined, hasCalls: boolean): FinishReason {
  if (reason === 'length') return 'max_tokens';
  if (hasCalls) return 'tool_use';
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    default:
      return 'other';
  }
}

/**
 * Вызов инструмента, написанный текстом вместо `tool_calls`.
 *
 * Берём только явную форму `{"tool": "...", "arguments": {...}}` (и синонимы имени поля).
 * Угадывать дальше нельзя: свободный JSON в ответе — это чаще кусок артефакта, чем вызов,
 * и приняв его за вызов, мы бы исполнили то, чего модель не просила.
 */
export function toolCallFromText(text: string, known: ReadonlySet<string>): ChatToolCall | null {
  // Кандидаты ищем по КАЖДОЙ открывающей скобке, а не только по первой: модель часто
  // пишет вызов после прозы, в которой фигурная скобка уже встретилась (пример формата,
  // фрагмент кода), и с фиксированным началом ни одна нарезка не разбиралась.
  //
  // Границы объекта считаем сканером, а не перебором всех закрывающих скобок: перебор
  // давал квадратичный JSON.parse на горячем пути — ответ на 20 КБ с тремя сотнями
  // скобок разбирался мегабайтами впустую.
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start);
    if (end < 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const r = parsed as Record<string, unknown>;
    const name = [r['tool'], r['tool_name'], r['name'], r['function']].find(
      (v): v is string => typeof v === 'string',
    );
    if (name === undefined || !known.has(name)) continue;
    const args = r['arguments'] ?? r['parameters'] ?? r['input'] ?? r['args'];
    return {
      id: `text-${name}`,
      name,
      arguments: typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {},
      rawArguments: JSON.stringify(args ?? {}),
    };
  }
  return null;
}

/**
 * Параметры из конфига модели (`ModelDef.params`) — поверх собранного тела запроса:
 * оператор сознательно перекрывает наши умолчания (temperature, max_tokens, tool_choice,
 * response_format, seed…). Служебные ключи не отдаются: их подмена ломала бы разбор
 * ответа, а не поведение модели, — `stream: true` молча оставил бы раннер ждать конца
 * несобираемого ответа, а подменённые `messages` разошлись бы с показанным оператору
 * промптом.
 */
export function applyParams(body: Record<string, unknown>, params: Record<string, unknown> | null): void {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (key === 'model' || key === 'messages' || key === 'tools' || key === 'stream') continue;
    body[key] = value;
  }
}

/** Индекс закрывающей скобки объекта, начинающегося в `start`. `-1` — не закрыт. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

export class OpenAiCompatProvider implements ChatProvider {
  readonly name: string;
  private readonly o: OpenAiCompatOptions;

  constructor(o: OpenAiCompatOptions) {
    this.name = o.name;
    this.o = o;
  }

  async chat(req: ChatRequest): Promise<ChatTurn> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => {
        switch (m.role) {
          case 'assistant':
            return {
              role: 'assistant',
              content: m.content,
              ...(m.toolCalls.length === 0
                ? {}
                : {
                    tool_calls: m.toolCalls.map((c) => ({
                      id: c.id,
                      type: 'function',
                      function: { name: c.name, arguments: c.rawArguments },
                    })),
                  }),
            };
          case 'tool':
            return { role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content };
          default:
            return { role: m.role, content: m.content };
        }
      }),
      ...(req.tools.length === 0
        ? {}
        : {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.schema },
            })),
          }),
      ...(req.temperature === null ? {} : { temperature: req.temperature }),
      stream: false,
    };

    applyParams(body, req.params ?? null);

    // Собственный таймаут поверх переданного сигнала: локальный сервер, ушедший в своп,
    // не закрывает соединение — этап висел бы до отмены оператором.
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    const signal = AbortSignal.any([req.signal, timeout]);

    const { status, text } = await postJson(
      `${this.o.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        'content-type': 'application/json',
        ...(this.o.apiKey === null ? {} : { authorization: `Bearer ${this.o.apiKey}` }),
      },
      JSON.stringify(body),
      signal,
    );

    if (status < 200 || status >= 300) {
      throw new Error(`${this.name}: HTTP ${status} от ${this.o.baseUrl} — ${text.slice(0, 500)}`);
    }

    let data: OpenAiResponse;
    try {
      data = JSON.parse(text) as OpenAiResponse;
    } catch {
      throw new Error(`${this.name}: ответ не разобрался как JSON — ${text.slice(0, 500)}`);
    }
    if (data.error?.message !== undefined) throw new Error(`${this.name}: ${data.error.message}`);

    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? '';

    const toolCalls: ChatToolCall[] = (choice?.message?.tool_calls ?? []).flatMap((c, i) => {
      const name = c.function?.name;
      if (typeof name !== 'string' || name === '') return [];
      const { args, text: raw } = parseArguments(c.function?.arguments);
      return [{ id: c.id ?? `call-${i}`, name, arguments: args, rawArguments: raw }];
    });

    if (toolCalls.length === 0 && content !== '') {
      const known = new Set(req.tools.map((t) => t.name));
      const fromText = toolCallFromText(content, known);
      if (fromText !== null) toolCalls.push(fromText);
    }

    const usage: Usage = {
      ...emptyUsage(),
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      // Стоимость показываем ТОЛЬКО когда её назвал сервер. Локальный маршрут её не знает,
      // и подставить сюда ноль значило бы «посчитали и вышло даром» — а мы не считали.
      costUsd: typeof data.usage?.cost === 'number' ? data.usage.cost : null,
      durationMs: Date.now() - started,
    };

    return {
      text: content,
      toolCalls,
      finishReason: mapFinish(choice?.finish_reason, toolCalls.length > 0),
      usage,
    };
  }
}

/**
 * POST JSON через `node:http` — намеренно НЕ через `fetch`.
 *
 * У встроенного `fetch` (undici) свой потолок ожидания заголовков — 300 секунд, и он не
 * настраивается из `RequestInit`. Ответ мы просим НЕ потоковый, поэтому сервер шлёт
 * заголовки только когда весь ответ готов: любая генерация дольше пяти минут умирала
 * `fetch failed` независимо от нашего `chatTimeoutMs`.
 *
 * Поймано измерением: 14B через ollama и 35B-A3B через LM Studio — разные серверы, разные
 * модели, обе умерли на 303 секундах. Это выглядело как «железо не тянет», а было чужим
 * таймаутом: единственный видимый признак — слово «failed» без кода и без причины.
 *
 * Здесь ожиданием управляет только переданный сигнал: наш таймаут уже сложен из
 * `chatTimeoutMs` и отмены прогона.
 */
function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;

    const request = transport.request(
      target,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        // Ноль — «ждать столько, сколько скажет сигнал»: генерация локальной модели
        // легально идёт минутами, и своего потолка у транспорта быть не должно.
        timeout: 0,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );

    const onAbort = (): void => {
      request.destroy(new Error('запрос к модели отменён'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    request.on('close', () => signal.removeEventListener('abort', onAbort));

    request.on('error', reject);
    request.end(body);
  });
}
