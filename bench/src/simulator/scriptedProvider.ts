import { isDeepStrictEqual } from 'node:util';
import { ProviderEnvError } from '../../../server/src/provider/ChatProvider.ts';
import { emptyUsage } from '@sdlc-runner/shared';
import type { ChatProvider, ChatRequest, ChatTurn } from '../../../server/src/provider/ChatProvider.ts';

export type ScriptedReply = ChatTurn | Error | ((request: ChatRequest) => ChatTurn | Promise<ChatTurn>);
export interface ScriptedExchange {
  request: Omit<ChatRequest, 'signal'>;
  response?: ChatTurn;
  error?: { name: string; message: string };
}
/** Конечный сценарий: отсутствие ответа всегда ошибка, никогда не фиктивный успех. */
export class ScriptedProvider implements ChatProvider {
  readonly name: string;
  readonly errors: string[] = [];
  private readonly replies: readonly ScriptedReply[];
  readonly exchanges: ScriptedExchange[] = [];
  readonly requests: Omit<ChatRequest, 'signal'>[] = [];
  private cursor = 0;
  constructor(name: string, replies: readonly ScriptedReply[]) { this.name = name; this.replies = replies; }
  get remaining(): number { return this.replies.length - this.cursor; }
  async chat(request: ChatRequest): Promise<ChatTurn> {
    const { signal: _signal, ...snapshot } = request;
    const saved = structuredClone(snapshot);
    this.requests.push(saved);
    const exchange: ScriptedExchange = { request: saved };
    this.exchanges.push(exchange);
    try {
      if (this.cursor >= this.replies.length) { this.errors.push('SIMULATOR_SCRIPT_EXHAUSTED'); throw new Error('SIMULATOR_SCRIPT_EXHAUSTED'); }
      const reply = this.replies[this.cursor++]!;
      if (reply instanceof Error) throw reply;
      const response = typeof reply === 'function' ? await reply(request) : structuredClone(reply);
      exchange.response = structuredClone(response);
      return response;
    } catch (error) {
      exchange.error = error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) };
      throw error;
    }
  }
}
export function textReply(text = 'Готово'): ChatTurn {
  return { text, toolCalls: [], finishReason: 'end_turn', usage: emptyUsage() };
}
export function toolReply(name: string, args: Record<string, unknown> | null = {}, id = crypto.randomUUID()): ChatTurn {
  return { text: '', toolCalls: [{ id, name, arguments: args, rawArguments: args === null ? '{broken' : JSON.stringify(args) }], finishReason: 'tool_use', usage: emptyUsage() };
}

export const textTurn = textReply;
export const toolTurn = toolReply;

/** Воспроизведение допустимо только для того же контекста; несовпадение закрывает всю запись. */
export function replayProvider(name: string, recorded: readonly ScriptedExchange[]): ScriptedProvider {
  const snapshots = structuredClone(recorded);
  for (const [index, exchange] of snapshots.entries()) {
    if ((exchange.response === undefined) === (exchange.error === undefined))
      throw new Error(`SIMULATOR_INVALID_RECORDING: exchange ${index} needs exactly one response or error`);
  }
  let mismatched = false;
  const provider = new ScriptedProvider(name, snapshots.map((exchange, index) => request => {
    const { signal: _signal, ...actual } = request;
    if (mismatched || !isDeepStrictEqual(actual, exchange.request)) {
      mismatched = true;
      const message = `SIMULATOR_REPLAY_CONTEXT_MISMATCH: exchange ${index}`;
      provider.errors.push(message);
      throw new Error(message);
    }
    if (exchange.error) {
      if (exchange.error.name === 'ProviderEnvError') throw new ProviderEnvError(exchange.error.message);
      const error = new Error(exchange.error.message);
      error.name = exchange.error.name;
      throw error;
    }
    return structuredClone(exchange.response!);
  }));
  return provider;
}
