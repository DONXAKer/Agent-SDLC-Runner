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

import type { ToolName } from '@sdlc-runner/shared';
import { finalizeRejection } from '../artifacts/finalizeCheck.ts';
import { normalize } from './normalize.ts';
import type { ExecHooks, ExecRequest, StageExecutor, StageResult } from './StageExecutor.ts';
import { TOOL_SPECS, isBuiltinToolName } from './toolSpecs.ts';
import { executeTool, type ToolContext } from './tools/index.ts';

/**
 * Инструменты рантайма, которых у Claude Code нет: вопрос человеку, финализация артефакта
 * и `fill_field`. Последний — не просто уведомление о решении, принятом в `onToolRequest`
 * (как у остальных здесь): у него нет встроенного аналога в SDK, значит запись на диск
 * обязана произойти в ЭТОМ обработчике, тем же `executeTool`, что и во флоу `loop` — иначе
 * появилось бы второе место, исполняющее `FillField` по-своему.
 *
 * `allowedTools` сужает СОСТАВ регистрируемых инструментов, а не только право их звать:
 * `canUseTool` всё равно перепроверит вызов по факту, но замер (r34, docs/model-runs.md)
 * поймал живой дефект без этого сужения — сервер регистрировал все шесть инструментов
 * безусловно, рецензент этапа 6 (свои права — только `Read`/`Grep`/`Glob`/`Bash`, ни
 * `RecordClaim`, ни `RecordFinding` среди них нет) ВИДЕЛ `record_claim` в своём списке
 * инструментов и раз за разом пытался его звать (по разу на пункт приёмки — 8 отклонённых
 * попыток на попытку прогона), каждый раз получая отказ политики. Модель, у которой
 * инструмента нет в списке вовсе, не тратит на него ход.
 */
function sdlcMcpServer(
  hooks: ExecHooks,
  toolCtx: ToolContext,
  allowedTools: readonly ToolName[],
  formArtifacts: readonly string[],
) {
  const has = (t: ToolName): boolean => allowedTools.includes(t);
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
      // Политику вызов уже прошёл через `canUseTool` — см. комментарий в `ask_human`, но
      // ТУДА не входит проверка готовности артефакта: этот обработчик раньше принимал
      // «готово» безусловно, в отличие от того же случая во флоу `loop`
      // (`LoopExecutor.ts`, `case 'finalize_artifact'`) — разъезд с инвариантом «два
      // флоу — одна форма вызова и одно решение политики» (для сильных моделей флоу sdk
      // редко всплывал, но раз строится общая проверка — `finalizeCheck.ts` — она идёт
      // в оба места).
      const rejection = finalizeRejection(args.artifact, toolCtx.projectRoot, formArtifacts);
      const text = rejection ?? `Артефакт принят рантаймом: ${args.artifact}`;
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

  const recordClaim = tool(
    'record_claim',
    TOOL_SPECS.RecordClaim.description,
    {
      id: z.string(),
      status: z.string(),
      evidence: z.string(),
      what_to_fix: z.string().optional(),
    },
    async (args) => {
      // Политику вызов уже прошёл через `canUseTool` — см. комментарий в `ask_human`.
      const call = normalize('record_claim', args as unknown as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: hooks.onRecord(call) }] };
    },
  );

  const recordFinding = tool(
    'record_finding',
    TOOL_SPECS.RecordFinding.description,
    { section: z.string(), text: z.string(), evidence: z.string().optional() },
    async (args) => {
      const call = normalize('record_finding', args as unknown as Record<string, unknown>);
      return { content: [{ type: 'text' as const, text: hooks.onRecord(call) }] };
    },
  );

  const fillField = tool(
    'fill_field',
    TOOL_SPECS.FillField.description,
    {
      artifact: z.string(),
      field: z.string(),
      value: z.string(),
      op: z.enum(['set', 'add']).optional(),
    },
    async (args) => {
      // Политику вызов уже прошёл через `canUseTool` — см. комментарий в `ask_human`. Сама
      // запись — здесь: `fill_field` не встроен в SDK, аналога «SDK сам пишет файл» у него
      // нет, и `executeTool` тот же, что у флоу `loop` (единая точка исполнения).
      const call = normalize('fill_field', args as unknown as Record<string, unknown>);
      const outcome = await executeTool(call, toolCtx);
      return { content: [{ type: 'text' as const, text: outcome.text }] };
    },
  );

  const registered = [
    ...(has('AskHuman') ? [askHuman] : []),
    ...(has('FinalizeArtifact') ? [finalize] : []),
    ...(has('RequestScopeExtension') ? [requestScopeExtension] : []),
    ...(has('RecordClaim') ? [recordClaim] : []),
    ...(has('RecordFinding') ? [recordFinding] : []),
    ...(has('FillField') ? [fillField] : []),
  ];

  return createSdkMcpServer({
    name: 'sdlc',
    version: '0.1.0',
    tools: registered,
  });
}

/**
 * Текст ошибки инструмента из `tool_result.content` — SDK отдаёт его либо строкой, либо
 * массивом блоков (обычно один `{type:'text', text}`). Схема, провалившая валидацию (как
 * `AskHuman` без `options`), не доходит до `onToolRequest` вовсе — этот текст единственный
 * след причины.
 */
export function toolResultErrorText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .filter((s) => s !== '')
      .join('\n');
  }
  return '';
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

    // Имена встроенных инструментов Claude Code + наши MCP-инструменты + отобранный набор
    // внешних. `McpRead`/`McpWrite` — права, а не инструменты: за ними стоят имена, которые
    // отдал живой сервер, поэтому в `TOOL_SPECS` их нет и разворачиваются они отдельно.
    const sdkToolNames = [
      ...req.allowedTools.filter(isBuiltinToolName).map((t) => TOOL_SPECS[t].sdkName),
      ...(req.mcp?.tools ?? []).map((t) => t.name),
    ];

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
        // Внешние серверы соседствуют с нашим in-process. Соединения к ним держит SDK, а
        // не наш хаб: два клиента к одному редактору спорили бы за одну PIE-сессию.
        mcpServers: {
          sdlc: sdlcMcpServer(
            hooks,
            {
              projectRoot: req.cwd,
              // `FillField` не режет результат по этим потолкам (артефакты витка — markdown
              // на десятки КБ, не то, ради чего заведён `maxResultBytes`); значения здесь —
              // только чтобы `ToolContext` был валиден для общего `executeTool`.
              maxResultBytes: 5_000_000,
              readRangeRequiredAboveBytes: 5_000_000,
              timeoutMs: 0,
              signal: req.signal,
              ...(req.stageArtifacts === undefined ? {} : { artifacts: req.stageArtifacts }),
            },
            req.allowedTools,
            req.formArtifacts ?? [],
          ),
          ...(req.mcp?.sdkServers ?? {}),
        },
        // `settingSources: []` не перекрывает автоподключение личных claude.ai-коннекторов
        // (Gmail/Drive/Calendar) — это отдельный канал SDK, живущий вне «настроек».
        // Контрольный прогон бенчмарка поймал их подключенными к сессии витка: агент
        // методологии получал бы личную почту и диск оператора, ничего для этого не
        // объявляя и не спрашивая. `strictMcpConfig` — задокументированный флаг именно
        // для этого случая: MCP только из `mcpServers` выше, ничего сверх.
        strictMcpConfig: true,
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

          // Харнесс сам сообщает, что у агента на руках. Сверяем с объявленным набором:
          // если фактических инструментов больше, значит `tools:` отфильтровал не всё, и
          // молчать об этом нельзя ровно по той же причине, по которой не молчат о
          // вызовах мимо гейта.
          case 'system': {
            if (m.subtype !== 'init') break;
            for (const srv of m.mcp_servers) {
              hooks.onWarn(`MCP-сервер «${srv.name}»: ${srv.status}`);
            }
            const declared = new Set(sdkToolNames);
            const extra = m.tools.filter((t) => t.startsWith('mcp__') && !declared.has(t));
            if (extra.length > 0) {
              hooks.onWarn(
                `харнесс дал агенту MCP-инструменты сверх объявленного набора: ${extra.join(', ')}`,
              );
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
              const isError = block.is_error === true;
              hooks.onToolResult({
                requestId: block.tool_use_id,
                ok: !isError,
                summary: attempted.get(block.tool_use_id) ?? 'инструмент отработал',
                durationMs: Date.now() - started,
                ...(isError ? { detail: toolResultErrorText(block.content) } : {}),
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
      } else if (isSdkTransportAbort(e)) {
        // Наблюдение живого витка: `for await` над `response` изредка рвётся `AbortError`
        // ("Stream closed"), которую SDK бросает не по нашей отмене (`req.signal` не
        // взведён) — похоже на гонку/закрытие канала подпроцесса `claude` после долгого
        // tool-вызова. Раньше это уходило в `throw e` необработанным исключением: этап
        // падал без единого события в шину, и оператору приходилось писать отчёт вручную,
        // не имея от рантайма даже честного «упало». Автопересоздание сессии здесь
        // сознательно НЕ сделано: у частично прошедшего диалога нет проверенного способа
        // продолжить с той же точки без риска повторить уже исполненные Write/Bash —
        // это следующий шаг, требующий репродукции на живом SDK, а не догадки.
        const detail = (e as Error).message || 'AbortError';
        ok = false;
        note = `этап оборван: канал SDK-процесса закрылся (${detail}), не отмена оператора`;
        hooks.onWarn(
          `[sdk] канал закрыт — ${detail}. Автопересоздание сессии не реализовано: продолжи этап ` +
            `вручную (retry chunk'а/verify), не полагайся на то, что модель помнит частично ` +
            `прошедший диалог.`,
        );
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

    // Спасение напечатанного артефакта — и здесь тоже. Цикл этого флоу крутит харнесс, и
    // вмешаться в середину нельзя, но проверить исход по диску можно ровно так же: модель
    // с равной вероятностью печатает содержимое артефакта текстом на любом маршруте, и
    // исход этапа не должен зависеть от того, кто крутит цикл. Пока спасение жило только
    // во флоу `loop`, один и тот же ответ давал там зелёный этап, а здесь — красный.
    if (ok && req.finishGuard !== null && req.finishGuard() !== null && req.salvageFromText !== null) {
      const saved = await req.salvageFromText(finalText);
      if (saved !== null) hooks.onWarn(saved);
    }

    return { ok, finalText, usage: latestUsage, note };
  }
}

/**
 * Отличает разрыв канала SDK-подпроцесса от нашей же отмены (`req.signal`).
 *
 * Экспортируемый класс SDK `AbortError` (`sdk.mjs`) — это `DOMException` с
 * `name === 'AbortError'`, которым SDK сигналит и штатные внутренние остановки
 * (`interrupt`, `background`, `subagent-park`), и разрыв транспорта. По коду отличить
 * причину нечем — SDK не публикует отдельный класс на «канал закрыл подпроцесс», —
 * поэтому здесь ловится весь класс `AbortError`, дошедший НЕ через `req.signal`: раз
 * оператор не отменял, а SDK всё равно бросила `AbortError`, это её собственная причина
 * останова, и молчаливый `throw e` для неё не годится ни в одном из вложенных случаев.
 */
export function isSdkTransportAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/** SDK принимает AbortController, а машина витка отдаёт сигнал. */
function toAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
}
