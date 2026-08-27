/**
 * Один внешний MCP-сервер: подключение, список инструментов, вызов.
 *
 * Процессом stdio-сервера владеет транспорт из `@modelcontextprotocol/sdk` — он и держит
 * дочерний процесс с открытым stdin, и закрывает его. Своего менеджера процессов здесь
 * нет намеренно: в `sandbox/` живёт модель «одна команда → результат», и притащить её
 * сюда значило бы написать второй, худший транспорт.
 *
 * Недоступный сервер — обычное состояние, а не сбой: редактор выключен, порт закрыт,
 * бинарника нет. Поэтому наружу всё отдаётся состоянием с причиной, а не исключением.
 */

import { existsSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { McpServerState } from '@sdlc-runner/shared';

import { hasUnexpanded } from '../config/mcp.ts';
import type { McpServerSpec } from '../config/mcp.ts';
import { fullName } from './naming.ts';
import type { McpToolInfo } from './types.ts';

/** Сколько байт stderr дочернего процесса держим для диагностики. */
const STDERR_TAIL_BYTES = 4_000;

export type TransportFactory = (
  spec: McpServerSpec,
  onStderr: (chunk: string) => void,
) => Transport;

// Приведение через `unknown` — не небрежность: у нас включён `exactOptionalPropertyTypes`,
// а транспорты SDK объявляют `sessionId: string | undefined` там, где интерфейс `Transport`
// ждёт `sessionId?: string`. Расхождение чужих деклараций, чинить которое у себя нечем.
const asTransport = (t: unknown): Transport => t as Transport;

/** Боевая фабрика транспортов. В тестах подменяется на `InMemoryTransport`. */
export const realTransport: TransportFactory = (spec, onStderr) => {
  if (spec.transport === 'http') {
    return asTransport(
      new StreamableHTTPClientTransport(new URL(spec.url), {
        requestInit: { headers: spec.headers },
      }),
    );
  }

  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...process.env, ...spec.env } as Record<string, string>,
    cwd: spec.cwd,
    stderr: 'pipe',
  });
  // stderr дочернего процесса — единственное место, где видно «команда не найдена» и
  // «модуль не импортируется»: без него недоступный сервер выглядит немым.
  transport.stderr?.on('data', (c: Buffer) => onStderr(c.toString('utf8')));
  return asTransport(transport);
};

export class McpClient {
  readonly spec: McpServerSpec;

  private client: Client | null = null;
  private tools: McpToolInfo[] = [];
  private stderr = '';
  private state: McpServerState = 'pending';
  private reason: string | null = null;
  /** Подключение в полёте: одновременные `ensureReady` не должны плодить процессы. */
  private connecting: Promise<boolean> | null = null;
  private readonly makeTransport: TransportFactory;

  constructor(spec: McpServerSpec, makeTransport: TransportFactory = realTransport) {
    this.spec = spec;
    this.makeTransport = makeTransport;
  }

  get name(): string {
    return this.spec.name;
  }

  status(): { state: McpServerState; reason: string | null; toolCount: number | null } {
    return {
      state: this.state,
      reason: this.reason,
      toolCount: this.state === 'connected' ? this.tools.length : null,
    };
  }

  stderrTail(): string | null {
    return this.stderr === '' ? null : this.stderr;
  }

  listTools(): readonly McpToolInfo[] {
    return this.tools;
  }

  /** Подключиться, если ещё не подключены. `false` — сервер недоступен, причина в `status()`. */
  async ensureReady(): Promise<boolean> {
    if (this.state === 'connected') return true;
    if (this.connecting !== null) return this.connecting;

    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private unexpandedProblem(): string | null {
    const values =
      this.spec.transport === 'http'
        ? [this.spec.url, ...Object.values(this.spec.headers)]
        : [this.spec.command, ...this.spec.args, ...Object.values(this.spec.env)];
    const bad = values.find((v) => hasUnexpanded(v));
    return bad === undefined ? null : `переменная не задана в окружении: ${bad}`;
  }

  private async connect(): Promise<boolean> {
    const unexpanded = this.unexpandedProblem();
    if (unexpanded !== null) return this.fail(unexpanded);

    // В контейнере раннера нет ни python, ни uv (образ — node:22-slim плюс git и docker.io),
    // поэтому stdio-сервер целевого проекта там не запустится никогда. Сказать это прямо
    // дешевле, чем отдать оператору «ENOENT: no such file or directory».
    if (this.spec.transport === 'stdio' && existsSync('/.dockerenv')) {
      return this.fail(
        'раннер работает в контейнере, а stdio-сервер запускается его командой на хосте: ' +
          'в образе нет ни python, ни uv. Для этого сервера нужен транспорт http через ' +
          'host.docker.internal, либо запуск раннера прямо на машине проекта',
      );
    }

    const client = new Client({ name: 'agent-sdlc-runner', version: '0.1.0' });
    try {
      const transport = this.makeTransport(this.spec, (chunk) => this.pushStderr(chunk));
      await client.connect(transport, { timeout: this.spec.connectTimeoutMs });
      const listed = await client.listTools(undefined, { timeout: this.spec.connectTimeoutMs });

      this.client = client;
      this.tools = listed.tools.map((t) => ({
        server: this.spec.name,
        tool: t.name,
        name: fullName(this.spec.name, t.name),
        description: t.description ?? '',
        schema: t.inputSchema as Record<string, unknown>,
        readOnlyHint: t.annotations?.readOnlyHint ?? null,
        destructiveHint: t.annotations?.destructiveHint ?? null,
      }));
      this.state = 'connected';
      this.reason = null;
      return true;
    } catch (e) {
      await client.close().catch(() => {});
      const tail = this.stderr === '' ? '' : ` stderr: ${this.stderr.slice(-500)}`;
      return this.fail(`${(e as Error).message}${tail}`);
    }
  }

  private fail(reason: string): boolean {
    this.state = 'unavailable';
    this.reason = reason;
    this.client = null;
    this.tools = [];
    return false;
  }

  private pushStderr(chunk: string): void {
    this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_BYTES);
  }

  /**
   * Вызов инструмента. Бросает — падение сервера ловит вызывающий и превращает в
   * неуспешный результат инструмента: этап от MCP не падает.
   */
  async callTool(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: unknown; isError: unknown }> {
    if (this.client === null) {
      throw new Error(
        `сервер «${this.spec.name}» не подключён: ${this.reason ?? 'причина не названа'}`,
      );
    }
    const result = await this.client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: this.spec.callTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    return { content: result.content, isError: result.isError };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.state = 'disabled';
    this.tools = [];
    if (client !== null) await client.close().catch(() => {});
  }
}
