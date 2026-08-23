/**
 * Флоу `sdk`: этап исполняет Claude Agent SDK.
 *
 * Почему он есть, хотя свой цикл всё равно нужен для локальных моделей: `canUseTool` даёт
 * полный перехват (отклонить и подменить аргументы) и при этом идёт по Max-подписке — под
 * капотом запускается локальный `claude`. Отказываться от этого ради единообразия значило
 * бы платить по API-ключу за то, что уже оплачено.
 *
 * Ограничение, которое здесь честно отслеживается: SDK может исполнить инструмент, не
 * спросив `canUseTool` (авто-разрешение харнесса). Такие вызовы мы не можем остановить,
 * но обязаны их назвать — иначе «всё прошло через гейт» будет ложным зелёным.
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import type { Usage } from '@sdlc-runner/shared';
import { describeCall, emptyUsage } from '@sdlc-runner/shared';

import { normalize } from './normalize.ts';
import type { ExecHooks, ExecRequest, StageExecutor, StageResult } from './StageExecutor.ts';
import { TOOL_SPECS } from './toolSpecs.ts';

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
      // Политику этот вызов уже прошёл: SDK спрашивает `canUseTool` и для MCP-инструментов.
      // Второй заход сюда давал оператору ДВЕ карточки на один вопрос, и закрытие только
      // одной оставляло вторую висеть неотвеченной.
      const answers = await hooks.onAskHuman(call);
      return { content: [{ type: 'text' as const, text: JSON.stringify(answers, null, 2) }] };
    },
  );

  const finalize = tool(
    'finalize_artifact',
    TOOL_SPECS.FinalizeArtifact.description,
    { artifact: z.string(), note: z.string().optional() },
    async (args) => {
      // Политику вызов уже прошёл через `canUseTool` — см. комментарий в `ask_human`.
      const text = `Артефакт принят рантаймом: ${args.artifact}`;
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  const requestScopeExtension = tool(
    'request_scope_extension',
    TOOL_SPECS.RequestScopeExtension.description,
    { path: z.string(), reason: z.string() },
    async (args) => {
      // Дописывание `plan.md` и пересчёт `ctx.planFiles` уже произошли в `onToolRequest`
      // ДО того, как SDK вообще позвал этот обработчик, — см. комментарий в `ask_human`.
      const text = `«${args.path}» добавлен в files_to_touch — теперь его можно писать`;
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  return createSdkMcpServer({
    name: 'sdlc',
    version: '0.1.0',
    tools: [askHuman, finalize, requestScopeExtension],
  });
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
    /** Когда вызов начался — для честной длительности в событии результата. */
    const startedAt = new Map<string, number>();

    /**
     * `total_cost_usd` и `usage` в result-сообщении кумулятивны по контракту SDK
     * («read the latest result rather than summing across results»). Складывать их
     * означало бы завысить стоимость витка кратно числу result-сообщений — и по этой
     * же завышенной сумме оператор видел бы приближение к бюджету.
     */
    let latestUsage = emptyUsage();
    let finalText = '';
    let note = 'этап завершён';
    let ok = true;

    // Имена встроенных инструментов Claude Code + наши MCP-инструменты.
    const sdkToolNames = req.allowedTools.map((t) => TOOL_SPECS[t].sdkName);

    const agents = Object.fromEntries(
      req.subagents.map((a) => [
        a.name,
        {
          description: a.description,
          prompt: a.prompt,
          // `tools: null` — строки в файле агента нет, и поле не выставляется: SDK сам
          // трактует его отсутствие как «наследует права вызывающего».
          ...(a.tools !== null && a.tools.length > 0 ? { tools: a.tools } : {}),
          ...(a.model === null ? {} : { model: a.model }),
        },
      ]),
    );

    const response = query({
      prompt: req.prompt.user,
      options: {
        cwd: req.cwd,
        model: req.model,
        abortController: toAbortController(req.signal),
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
        // Каталоги форм методологии и текстов этапов: промпт велит их читать, а лежат
        // они вне целевого проекта.
        ...(req.readOnlyDirs.length > 0 ? { additionalDirectories: [...req.readOnlyDirs] } : {}),
        ...(Object.keys(agents).length > 0 ? { agents } : {}),
        maxTurns: req.maxTurns,
        ...(req.maxBudgetUsd === null ? {} : { maxBudgetUsd: req.maxBudgetUsd }),

        canUseTool: async (toolName, input, opts) => {
          gated.add(opts.toolUseID);
          const call = normalize(toolName, input);
          const started = Date.now();
          const decision = await hooks.onToolRequest(call, {
            requestId: opts.toolUseID,
            toolName,
            rawInput: input as Record<string, unknown>,
            // Во флоу `sdk` вложенные прогоны крутит сам SDK, и своего списка прав у
            // вызова здесь нет — правами вызывающего остаются права этапа.
            callerTools: req.allowedTools,
          });

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

    try {
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
                // Описание вызова, а не одно его имя: это единственный след вызовов,
                // исполненных мимо гейта, и «Write; Write; Bash» не говорит оператору
                // ничего о том, что именно записалось. Прежнее выражение с тернарником,
                // возвращавшим пустую строку в обеих ветках, было тождественно имени.
                const input = 'input' in block ? (block.input as Record<string, unknown>) : {};
                attempted.set(block.id, describeCall(normalize(block.name, input)));
                startedAt.set(block.id, Date.now());
              }
            }
            break;
          }

          case 'result': {
            latestUsage = usageFromResult(m);
            if (m.subtype !== 'success') {
              ok = false;
              note = `этап оборван: ${m.subtype}`;
            } else {
              note = `этап завершён за ${m.num_turns} ход(ов)`;
            }
            break;
          }

          // Результат исполненного инструмента приходит отдельным сообщением от SDK.
          // Без этой ветки `onToolResult` вызывался ТОЛЬКО при отказе политики: успешный
          // вызов не давал ни события в шину, ни факта «инструмент отработал» — а на
          // последнем держится статус гейта «Ревью независимым агентом», и он не мог
          // стать зелёным ни на одной попытке.
          case 'user': {
            const content = m.message.content;
            if (typeof content === 'string') break;
            for (const block of content) {
              if (block.type !== 'tool_result') continue;
              const started = startedAt.get(block.tool_use_id) ?? Date.now();
              hooks.onToolResult({
                requestId: block.tool_use_id,
                ok: block.is_error !== true,
                summary: attempted.get(block.tool_use_id) ?? 'инструмент отработал',
                durationMs: Date.now() - started,
              });
            }
            break;
          }

          default:
            break;
        }
      }
    } catch (e) {
      if (req.signal.aborted) {
        ok = false;
        note = 'этап отменён оператором';
      } else {
        throw e;
      }
    }

    hooks.onUsage(latestUsage);

    // Вызовы, исполненные мимо гейта. Остановить их задним числом нельзя, но молчать
    // о них нельзя тем более: «прошло через одобрение» должно означать ровно это.
    const ungated = [...attempted.entries()].filter(([id]) => !gated.has(id));
    if (ungated.length > 0) {
      hooks.onWarn(
        `${ungated.length} вызов(ов) исполнены без гейта одобрений (авто-разрешение харнесса): ` +
          ungated.map(([, d]) => d).join('; '),
      );
    }

    return { ok, finalText, usage: latestUsage, note };
  }
}

/** SDK принимает AbortController, а машина витка отдаёт сигнал. */
function toAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}
