/**
 * Флоу `sdk`: этап исполняет Claude Agent SDK.
 *
 * Почему он есть, хотя свой цикл всё равно написан: `canUseTool` даёт полный перехват
 * (отклонить и подменить аргументы) и при этом идёт по Max-подписке — под капотом
 * запускается локальный `claude`. Отказываться от этого ради единообразия значило бы
 * платить по API-ключу за то, что уже оплачено.
 *
 * Ограничение, которое здесь честно отслеживается: SDK может исполнить инструмент, не
 * спросив `canUseTool` (авто-разрешение харнесса). Такие вызовы мы не можем остановить,
 * но обязаны их назвать — иначе «всё прошло через гейт» будет ложным зелёным.
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { TOOL_SPECS } from './toolSpecs.ts';
import { describeCall, normalize } from './normalize.ts';
import type { ExecHooks, ExecRequest, StageExecutor, StageResult } from './StageExecutor.ts';
import { emptyUsage, type Usage } from '../types.ts';

/** Инструменты рантайма, которых у Claude Code нет: вопрос человеку и финализация артефакта. */
function sdlcMcpServer(hooks: ExecHooks) {
  const askHuman = tool(
    'ask_human',
    TOOL_SPECS.AskHuman.description,
    {
      questions: z
        .array(
          z.object({
            question: z.string(),
            header: z.string(),
            multiSelect: z.boolean().optional(),
            options: z.array(z.object({ label: z.string(), description: z.string() })),
          }),
        )
        .max(4),
    },
    async (args) => {
      const call = normalize('ask_human', args as unknown as Record<string, unknown>);
      const answers = await hooks.onAskHuman(call);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(answers, null, 2) }],
      };
    },
  );

  const finalize = tool(
    'finalize_artifact',
    TOOL_SPECS.FinalizeArtifact.description,
    { artifact: z.string(), note: z.string().optional() },
    async (args) => {
      const call = normalize('finalize_artifact', args as unknown as Record<string, unknown>);
      const decision = await hooks.onToolRequest(call, { requestId: `finalize:${args.artifact}` });
      const text = decision.allowed
        ? `Артефакт принят рантаймом: ${args.artifact}`
        : `Артефакт не принят: ${decision.reason}`;
      return { content: [{ type: 'text' as const, text }], isError: !decision.allowed };
    },
  );

  return createSdkMcpServer({ name: 'sdlc', version: '0.1.0', tools: [askHuman, finalize] });
}

function usageFromResult(m: {
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}): Usage {
  const u = m.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    costUsd: m.total_cost_usd ?? 0,
    durationMs: m.duration_ms ?? 0,
  };
}

export class SdkExecutor implements StageExecutor {
  readonly flow = 'sdk' as const;

  async run(req: ExecRequest, hooks: ExecHooks): Promise<StageResult> {
    /** Вызовы, которые дошли до гейта. */
    const gated = new Set<string>();
    /** Вызовы, которые агент вообще сделал (из сообщений ассистента). */
    const attempted = new Map<string, string>();

    let usage = emptyUsage();
    let finalText = '';
    let note = 'этап завершён';
    let ok = true;

    // Имена встроенных инструментов Claude Code + наши MCP-инструменты.
    const sdkToolNames = req.allowedTools.map((t) => TOOL_SPECS[t].sdkName);

    const response = query({
      prompt: req.prompt.user,
      options: {
        cwd: req.cwd,
        model: req.model,
        // Пресет несёт описания встроенных инструментов; наш текст этапа идёт добавкой.
        // Оператору это показано отдельной пометкой — «полный промпт» не притворяется полным.
        systemPrompt: { type: 'preset', preset: 'claude_code', append: req.prompt.system },
        // Ничего не подмешивается из настроек пользователя и проекта: всё, что уйдёт
        // в модель, собрано нами и показано в панели промпта.
        settingSources: [],
        // Права выдаются на шаг: доступны только инструменты этапа.
        tools: sdkToolNames,
        // allowedTools НЕ выставляем намеренно: он авто-разрешает вызовы, и тогда
        // canUseTool до них не доходит, а гейт одобрений становится декорацией.
        permissionMode: 'default',
        mcpServers: { sdlc: sdlcMcpServer(hooks) },
        maxTurns: req.maxTurns,
        ...(req.maxBudgetUsd === null ? {} : { maxBudgetUsd: req.maxBudgetUsd }),

        canUseTool: async (toolName, input, opts) => {
          gated.add(opts.toolUseID);
          const call = normalize(toolName, input);
          const started = Date.now();
          const decision = await hooks.onToolRequest(call, { requestId: opts.toolUseID });

          if (!decision.allowed) {
            hooks.onToolResult({
              requestId: opts.toolUseID,
              ok: false,
              summary: decision.reason,
              durationMs: Date.now() - started,
            });
            return { behavior: 'deny', message: decision.reason };
          }

          return decision.updatedInput === null
            ? { behavior: 'allow' }
            : { behavior: 'allow', updatedInput: decision.updatedInput as Record<string, unknown> };
        },
      },
    });

    for await (const m of response) {
      switch (m.type) {
        case 'assistant': {
          for (const block of m.message.content) {
            if (block.type === 'text') {
              finalText = block.text;
              hooks.onText(block.text);
            } else if (block.type === 'thinking') {
              hooks.onThinking(block.thinking);
            } else if (block.type === 'tool_use') {
              attempted.set(block.id, describeCall(normalize(block.name, block.input as Record<string, unknown>)));
            }
          }
          break;
        }

        case 'result': {
          usage = usageFromResult(m);
          hooks.onUsage(usage);
          if (m.subtype !== 'success') {
            ok = false;
            note = `этап оборван: ${m.subtype}`;
          } else {
            note = `этап завершён за ${m.num_turns} ход(ов)`;
          }
          break;
        }

        default:
          break;
      }
    }

    // Вызовы, исполненные мимо гейта. Остановить их задним числом нельзя, но молчать
    // о них нельзя тем более: «прошло через одобрение» должно означать ровно это.
    const ungated = [...attempted.entries()].filter(([id]) => !gated.has(id));
    if (ungated.length > 0) {
      hooks.onWarn(
        `${ungated.length} вызов(ов) исполнены без гейта одобрений (авто-разрешение харнесса): ` +
          ungated.map(([, d]) => d).join('; '),
      );
    }

    return { ok, finalText, usage, note };
  }
}
