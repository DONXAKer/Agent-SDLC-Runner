/**
 * Набор внешних MCP-серверов витка.
 *
 * Поднимается лениво, на этап: раннер обязан стартовать при выключенном редакторе, а
 * пересоздавать клиента на каждый вызов нельзя — между `pie_start` и `pie_screenshot`
 * живёт состояние сессии редактора. Гаснет на конце ВИТКА, а не этапа: погасив редактор
 * между chunk и verify, мы отняли бы у верификации ровно то, что она проверяет.
 *
 * Падение одного сервера не касается остальных и не роняет этап: наружу оно уходит
 * неуспешным результатом инструмента и предупреждением оператору.
 */

import type { McpServerInfo, McpServerState } from '@sdlc-runner/shared';

import type { McpServerSpec } from '../config/mcp.ts';
import { McpClient } from './McpClient.ts';
import type { TransportFactory } from './McpClient.ts';
import { foldContent } from './content.ts';
import type { FoldOptions } from './content.ts';
import type { McpCallOutcome, McpToolInfo } from './types.ts';

export class McpHub {
  private readonly clients = new Map<string, McpClient>();

  constructor(specs: readonly McpServerSpec[], makeTransport?: TransportFactory) {
    for (const spec of specs) {
      this.clients.set(
        spec.name,
        makeTransport === undefined ? new McpClient(spec) : new McpClient(spec, makeTransport),
      );
    }
  }

  get size(): number {
    return this.clients.size;
  }

  names(): string[] {
    return [...this.clients.keys()];
  }

  /**
   * Поднять названные серверы. Возвращает имена тех, что не поднялись, — вызывающий
   * решает, что с этим делать: этап продолжается в любом случае.
   */
  async ensureReady(names: readonly string[]): Promise<string[]> {
    const wanted = names.filter((n) => this.clients.has(n));
    const results = await Promise.all(
      wanted.map(async (n) => {
        const client = this.clients.get(n);
        return { name: n, ok: client === undefined ? false : await client.ensureReady() };
      }),
    );
    return results.filter((r) => !r.ok).map((r) => r.name);
  }

  /** Инструменты подключённых серверов из числа названных. */
  tools(names: readonly string[]): McpToolInfo[] {
    const out: McpToolInfo[] = [];
    for (const n of names) {
      const client = this.clients.get(n);
      if (client !== undefined) out.push(...client.listTools());
    }
    return out;
  }

  /** Опросные инструменты сервера: их повтор не считается топтанием на месте. */
  pollingPatterns(server: string): readonly string[] {
    return this.clients.get(server)?.spec.pollingTools ?? [];
  }

  status(server: string): {
    state: McpServerState;
    reason: string | null;
    toolCount: number | null;
  } {
    const client = this.clients.get(server);
    if (client === undefined) {
      return { state: 'disabled', reason: 'сервер не объявлен', toolCount: null };
    }
    return client.status();
  }

  /** Что показать оператору. `selected` заполняет вызывающий: набор зависит от этапа. */
  info(selectedByServer: ReadonlyMap<string, readonly string[]>): McpServerInfo[] {
    return [...this.clients.values()].map((client) => {
      const spec = client.spec;
      const s = client.status();
      return {
        name: spec.name,
        transport: spec.transport,
        // Секретов здесь нет по построению: у http показываем адрес без query, у stdio —
        // команду с аргументами, но никогда не значения env и заголовков.
        target:
          spec.transport === 'http'
            ? (spec.url.split('?')[0] ?? spec.url)
            : `${spec.command} ${spec.args.join(' ')}`.trim(),
        envKeys: spec.transport === 'http' ? Object.keys(spec.headers) : Object.keys(spec.env),
        state: s.state,
        reason: s.reason,
        toolCount: s.toolCount,
        selected: selectedByServer.get(spec.name) ?? [],
        stderrTail: client.stderrTail(),
      };
    });
  }

  /**
   * Вызов инструмента. Ошибка транспорта превращается в неуспешный результат: модель
   * должна прочитать причину и сменить ход, а не получить упавший этап.
   */
  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; fold?: FoldOptions } = {},
  ): Promise<McpCallOutcome> {
    const client = this.clients.get(server);
    if (client === undefined) {
      return { ok: false, text: `сервер «${server}» не объявлен на этом витке` };
    }

    try {
      const result = await client.callTool(tool, args, opts.signal);
      return foldContent(result, opts.fold ?? {});
    } catch (e) {
      return {
        ok: false,
        text: `сервер «${server}» не выполнил «${tool}»: ${(e as Error).message}`,
      };
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close()));
  }
}
