/**
 * Флоу `loop`: собственный цикл tool-use для локальных и OpenAI-совместимых моделей.
 *
 * Отличается от `SdkExecutor` ровно двумя вещами — кто крутит цикл и кто исполняет
 * инструменты. Всё остальное общее: нормализация вызова, гейт одобрений, политика, шина
 * событий. Это не вежливость к архитектуре, а единственное, что не даёт двум флоу
 * разъехаться в правах доступа.
 *
 * Слабости локальных моделей учтены здесь, а не в промпте — просьбы они выполняют хуже,
 * чем конструкции:
 *
 *  - **Зацикливание.** Тот же инструмент с теми же аргументами дважды подряд получает не
 *    результат, а замечание. Третий раз подряд обрывает этап: 4B-модель способна звать
 *    `Read` по одному файлу до конца бюджета.
 *  - **Сломанный JSON в аргументах.** Не падаем — говорим модели, что именно не
 *    разобралось, и даём переписать.
 *  - **Вызов, написанный текстом.** Вытаскивается провайдером; здесь он неотличим от
 *    настоящего и проходит тот же гейт.
 *  - **Объём результата.** Режется инструментом по `maxToolResultBytes`: локальный контур
 *    живёт на 16K контекста, и один `Grep` по монорепо съедает его целиком.
 */

import { randomUUID } from 'node:crypto';

import type { NormalizedCall, Usage } from '@sdlc-runner/shared';
import { addUsage, emptyUsage } from '@sdlc-runner/shared';

import type { ChatMessage, ChatProvider, ChatToolCall } from '../provider/ChatProvider.ts';
import { normalize } from './normalize.ts';
import type { ExecHooks, ExecRequest, StageExecutor, StageResult } from './StageExecutor.ts';
import { executeTool, type ToolContext } from './tools/index.ts';
import { specsFor } from './toolSpecs.ts';

export interface LoopOptions {
  provider: ChatProvider;
  maxResultBytes: number;
  readRangeRequiredAboveBytes: number;
  bashTimeoutMs: number;
  /** `null` — не задавать серверу температуру вовсе. */
  temperature: number | null;
}

/**
 * Сколько раз подряд один и тот же вызов терпим, прежде чем оборвать этап.
 *
 * Считается по числу ВЫЗОВОВ, а не по счётчику повторов: первый исполняется, второй
 * получает замечание, третий обрывает. Раньше обрыв наступал на четвёртом, потому что
 * счётчик начинался с нуля, — лишний полный round-trip к серверу на каждом залипании.
 */
const REPEAT_LIMIT = 3;

/** Инструмент есть, но исполнить его этот флоу не умеет: не успех и не крах этапа. */
export class SubagentUnavailable extends Error {}

function callFingerprint(call: ChatToolCall): string {
  return `${call.name}|${call.rawArguments}`;
}

export class LoopExecutor implements StageExecutor {
  readonly flow = 'loop' as const;
  private readonly o: LoopOptions;

  constructor(o: LoopOptions) {
    this.o = o;
  }

  async run(req: ExecRequest, hooks: ExecHooks): Promise<StageResult> {
    const toolCtx: ToolContext = {
      projectRoot: req.cwd,
      maxResultBytes: this.o.maxResultBytes,
      readRangeRequiredAboveBytes: this.o.readRangeRequiredAboveBytes,
      timeoutMs: this.o.bashTimeoutMs,
      signal: req.signal,
    };

    const tools = specsFor(req.allowedTools).map((s) => ({
      // Во флоу `loop` имена наши: MCP-префикса здесь нет, и подсовывать модели
      // `mcp__sdlc__ask_human` значило бы описывать несуществующий транспорт.
      name: s.name,
      description: s.description,
      schema: s.schema,
    }));

    const messages: ChatMessage[] = [
      { role: 'system', content: req.prompt.system },
      { role: 'user', content: req.prompt.user },
    ];

    let usage: Usage = emptyUsage();
    let finalText = '';
    let lastFingerprint: string | null = null;
    let repeats = 0;

    for (let turn = 1; turn <= req.maxTurns; turn++) {
      if (req.signal.aborted) {
        return { ok: false, finalText, usage, note: 'этап отменён' };
      }

      const answer = await this.o.provider.chat({
        model: req.model,
        messages,
        tools,
        signal: req.signal,
        temperature: this.o.temperature,
      });

      usage = addUsage(usage, answer.usage);
      hooks.onUsage(answer.usage);
      if (answer.text !== '') {
        finalText = answer.text;
        hooks.onText(answer.text);
      }

      // Бюджет прогона действует на обоих флоу. Проверяется ПОСЛЕ хода, а не до: цена
      // хода известна только по факту, и обрывать этап на непревышенном бюджете нельзя.
      const spent = usage.costUsd;
      if (req.maxBudgetUsd !== null && spent !== null && spent >= req.maxBudgetUsd) {
        const note = `бюджет прогона исчерпан: $${spent.toFixed(4)} из $${req.maxBudgetUsd}`;
        hooks.onWarn(note);
        return { ok: false, finalText, usage, note };
      }

      if (answer.toolCalls.length === 0) {
        // «Завершил ход» — это только end_turn. Всё прочее (лимит длины, фильтр
        // содержимого, оборванный поток, сервер без finish_reason) успехом не считается:
        // иначе этап, где модель не написала ни строки, помечался бы как выполненный.
        // `other` с непустым текстом — законное завершение: Ollama и часть сборок vLLM
        // не шлют `finish_reason` вовсе, и трактовать их ответ как обрыв значило бы
        // валить каждый этап на локальном профиле.
        const done =
          answer.finishReason === 'end_turn' ||
          (answer.finishReason === 'other' && answer.text.trim() !== '');
        const note = done
          ? 'модель завершила ход'
          : answer.finishReason === 'max_tokens'
            ? 'модель упёрлась в лимит длины ответа'
            : `ход оборван: причина завершения «${answer.finishReason}», вызовов инструментов нет`;
        return { ok: done, finalText, usage, note };
      }

      // Обрезанный по лимиту токенов ход с вызовами исполнять нельзя: аргументы у
      // последнего вызова заведомо неполны, а разбор их выдаст «сломанный JSON» и
      // отправит модель по кругу с неверным диагнозом.
      if (answer.finishReason === 'max_tokens') {
        const note = 'ход обрезан лимитом длины на середине вызова инструмента — не исполняем';
        hooks.onWarn(note);
        return { ok: false, finalText, usage, note };
      }

      messages.push({ role: 'assistant', content: answer.text, toolCalls: answer.toolCalls });

      for (const call of answer.toolCalls) {
        const fingerprint = callFingerprint(call);
        repeats = fingerprint === lastFingerprint ? repeats + 1 : 0;
        lastFingerprint = fingerprint;

        if (repeats + 1 >= REPEAT_LIMIT) {
          const note =
            `цикл остановлен: «${call.name}» вызван ${repeats + 1} раза подряд с теми же ` +
            `аргументами — прогресса нет`;
          hooks.onWarn(note);
          return { ok: false, finalText, usage, note };
        }

        const result = await this.handleCall(call, repeats, req, hooks, toolCtx);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: result,
        });
      }
    }

    return {
      ok: false,
      finalText,
      usage,
      note: `исчерпан лимит ходов этапа (${req.maxTurns})`,
    };
  }

  private async handleCall(
    call: ChatToolCall,
    repeats: number,
    req: ExecRequest,
    hooks: ExecHooks,
    toolCtx: ToolContext,
  ): Promise<string> {
    const started = Date.now();
    const requestId = `loop:${randomUUID()}`;

    if (call.arguments === null) {
      // Не падаем: говорим, что именно не разобралось. Модель, которой сказали «ошибка»
      // без подробностей, повторяет ту же строку.
      const text = `аргументы не разобрались как JSON: ${call.rawArguments.slice(0, 300)}`;
      hooks.onToolResult({ requestId, ok: false, summary: text, durationMs: 0 });
      return text;
    }

    if (repeats > 0) {
      const text =
        `этот вызов уже был с теми же аргументами и дал тот же результат. Он не повторён. ` +
        `Смени подход: либо другой инструмент, либо другие аргументы, либо заверши ход.`;
      hooks.onToolResult({ requestId, ok: false, summary: 'повторный вызов', durationMs: 0 });
      return text;
    }

    const normalized: NormalizedCall = normalize(call.name, call.arguments);

    const decision = await hooks.onToolRequest(normalized, {
      requestId,
      toolName: call.name,
      rawInput: call.arguments,
    });
    if (!decision.allowed) {
      hooks.onToolResult({ requestId, ok: false, summary: decision.reason, durationMs: 0 });
      return `вызов отклонён: ${decision.reason}`;
    }

    // Оператор вправе поправить аргументы — тогда исполняется именно правленый вызов,
    // а не исходный. Иначе кнопка «править аргументы» была бы декорацией. Политику
    // правленый вызов проходит заново — это делает гейт в `resolve`, до того как решение
    // доедет сюда.
    const effective =
      decision.updatedInput === null
        ? normalized
        : normalize(call.name, decision.updatedInput as Record<string, unknown>);

    let text: string;
    try {
      text = await this.execute(effective, req, hooks, toolCtx);
    } catch (e) {
      // Инструмент, который не может отработать, отчитывается ОШИБКОЙ — иначе «ok» на
      // заглушке становится доказательством того, чего не было (гейт ревью зеленел от
      // отказа запускать субагента).
      const message = e instanceof SubagentUnavailable ? e.message : (e as Error).message;
      hooks.onToolResult({
        requestId,
        ok: false,
        summary: message,
        durationMs: Date.now() - started,
      });
      return message;
    }

    hooks.onToolResult({
      requestId,
      ok: true,
      summary: text.split('\n')[0]?.slice(0, 200) ?? '',
      durationMs: Date.now() - started,
    });
    return text;
  }

  private async execute(
    call: NormalizedCall,
    req: ExecRequest,
    hooks: ExecHooks,
    toolCtx: ToolContext,
  ): Promise<string> {
    switch (call.kind) {
      case 'ask_human': {
        const answers = await hooks.onAskHuman(call);
        return Object.keys(answers).length === 0
          ? 'человек не ответил — считай вопрос пропущенным и запиши это в артефакт'
          : JSON.stringify(answers, null, 2);
      }

      case 'finalize_artifact':
        // Проверку заполненности делает рантайм при чтении артефакта; здесь только
        // подтверждение, что заявка принята.
        return `артефакт заявлен готовым: ${call.artifact}`;

      case 'subagent': {
        // Субагент во флоу `loop` — вложенный прогон того же цикла с урезанными правами.
        // Его отсутствие не проглатывается: методология держит на субагентах ровно то,
        // что нельзя доверить автору работы. Отдаётся ОШИБКОЙ, а не текстом: успешный
        // исход здесь засчитывался как состоявшееся ревью и зажигал обязательный гейт
        // на витке, где независимого рецензента не было вовсе.
        const note =
          `субагент «${call.agent}» во флоу loop не запускается. Этап 6 без независимого ` +
          `рецензента неполон — гейт «Ревью независимым агентом» останется ⏭.`;
        hooks.onWarn(note);
        throw new SubagentUnavailable(note);
      }

      default: {
        const outcome = await executeTool(call, toolCtx);
        return outcome.ok ? outcome.text : `ошибка: ${outcome.text}`;
      }
    }
  }
}
