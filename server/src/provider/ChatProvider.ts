/**
 * Провайдер чата для флоу `loop`.
 *
 * Флоу `sdk` сюда не заходит: там цикл крутит Agent SDK. Здесь — минимум, которого хватает
 * методологии: сообщения, инструменты, ответ с вызовами инструментов и расход.
 *
 * Стриминг сознательно не заводим. Локальная модель на 4B отвечает секунды, а не минуты,
 * и польза от посимвольного вывода не окупает второй путь разбора ответа — тот самый, где
 * два флоу и расходятся.
 */

import type { Usage } from '@sdlc-runner/shared';

export interface ChatToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ChatToolCall {
  id: string;
  name: string;
  /** Аргументы уже разобраны. Модель вернула не-JSON — это `null`, и цикл говорит ей об этом. */
  arguments: Record<string, unknown> | null;
  /** Исходная строка аргументов: нужна в диагностике, когда разбор не удался. */
  rawArguments: string;
}

export type FinishReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'other';

export interface ChatTurn {
  text: string;
  toolCalls: ChatToolCall[];
  finishReason: FinishReason;
  usage: Usage;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ChatToolDef[];
  signal: AbortSignal;
  /**
   * Температура. `null` — не отправлять поле вовсе: у части серверов «не задано» и «0»
   * ведут себя по-разному, и подставлять своё значение молча нельзя.
   */
  temperature: number | null;
  /**
   * Сырые поля тела запроса из конфига модели (`ModelDef.params`): temperature,
   * max_tokens, top_p, seed, response_format, tool_choice и прочее, что понимает сервер.
   *
   * Одно generic-поле вместо ручки на каждый параметр: журнал замеров требует менять
   * «одну настройку за прогон», и каждая новая ручка иначе означала бы правку кода.
   * Служебные ключи (model, messages, tools, stream) слиянием не перекрываются —
   * их подмена ломала бы разбор ответа, а не поведение модели.
   */
  params?: Record<string, unknown> | null;
}

export interface ChatProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatTurn>;
}
