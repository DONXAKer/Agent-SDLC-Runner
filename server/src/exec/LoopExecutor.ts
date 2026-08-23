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

import type { NormalizedCall, ToolName, Usage } from '@sdlc-runner/shared';
import { addUsage, emptyUsage } from '@sdlc-runner/shared';

import type { ChatMessage, ChatProvider, ChatToolCall } from '../provider/ChatProvider.ts';
import { normalize } from './normalize.ts';
import type {
  ExecHooks,
  ExecRequest,
  StageExecutor,
  StageResult,
  SubagentDef,
} from './StageExecutor.ts';
import { executeTool, type ToolContext } from './tools/index.ts';
import { TOOL_SPECS, specsFor } from './toolSpecs.ts';

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

/**
 * Имена инструментов субагента приходят строками из его YAML-шапки — файл пишет человек.
 * Незнакомое имя не превращается в право: оно просто не попадает в пересечение.
 */
// Реестр `TOOL_SPECS` типизирован как `Record<ToolName, ToolSpec>`, и его полноту следит
// компилятор. Рукописный список рядом был бы вторым знанием об одном: забытое в нём имя
// молча выпадало бы из пересечения прав, и субагент терял бы объявленное право без
// единого сообщения. `hasOwn`, а не `in`: объектный словарь отвечает `true` на `toString`.
function isToolName(v: string): v is ToolName {
  return Object.hasOwn(TOOL_SPECS, v);
}

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
      // Считается вместе с уже потраченным вне этого вызова: маршруты ансамбля и вложенные
      // субагенты делят ОДИН потолок витка, а не получают по своему.
      const spent = usage.costUsd === null ? null : usage.costUsd + (req.spentUsdBefore ?? 0);
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

      // Несколько субагентов, заказанных ОДНИМ ходом, запускаются параллельно: они не
      // делят состояние (у разведки этапа 2 второй агент выводит приёмочный лист вслепую,
      // не видя работы первого), а последовательный запуск удлинял этап на время самого
      // медленного из них подряд. Всё остальное по-прежнему строго последовательно:
      // инструменты делят рабочее дерево, и порядок правок значим.
      const parallelSubagents =
        answer.toolCalls.length > 1 &&
        answer.toolCalls.every((c) => normalize(c.name, c.arguments ?? {}).kind === 'subagent');

      if (parallelSubagents) {
        // Отпечаток хода целиком, а не последнего вызова: пока `repeats` здесь обнулялся
        // безусловно, модель, повторяющая одну и ту же пару `Task`, крутилась до
        // `maxTurns`, и каждый ход стоил двух полных вложенных прогонов.
        const turnFingerprint = answer.toolCalls.map(callFingerprint).join(' ');
        repeats = turnFingerprint === lastFingerprint ? repeats + 1 : 0;
        lastFingerprint = turnFingerprint;
        if (repeats + 1 >= REPEAT_LIMIT) {
          const note =
            `цикл остановлен: ход из ${answer.toolCalls.length} субагентов повторён ` +
            `${repeats + 1} раза подряд с теми же аргументами — прогресса нет`;
          hooks.onWarn(note);
          return { ok: false, finalText, usage, note };
        }

        const spentNow = (usage.costUsd ?? 0) + (req.spentUsdBefore ?? 0);
        const results = await Promise.all(
          answer.toolCalls.map((call) => this.handleCall(call, 0, req, hooks, toolCtx, spentNow)),
        );
        answer.toolCalls.forEach((call, idx) => {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: results[idx] ?? '',
          });
        });
        continue;
      }

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

        const result = await this.handleCall(
          call,
          repeats,
          req,
          hooks,
          toolCtx,
          (usage.costUsd ?? 0) + (req.spentUsdBefore ?? 0),
        );
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
    /** Уже потрачено на витке к моменту вызова — передаётся вложенному прогону субагента. */
    spentUsd: number,
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
      // Права текущего вызывающего, а не этапа: во вложенном прогоне субагента здесь
      // уже суженный список, и политика решает по нему.
      callerTools: req.allowedTools,
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
      text = await this.execute(effective, req, hooks, toolCtx, spentUsd);
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

  /**
   * Вложенный прогон субагента.
   *
   * Инструменты идут через ТЕ ЖЕ hooks, то есть через тот же гейт политики и то же
   * одобрение оператора: право на `Task` не расширяет права этапа, и второго места,
   * принимающего решение о доступе, здесь не появляется.
   *
   * Вложенность одноуровневая: субагенту субагенты не выдаются. Рекурсия означала бы
   * неограниченную глубину прав и бюджета.
   */
  private async runSubagent(
    req: ExecRequest,
    hooks: ExecHooks,
    def: SubagentDef,
    task: string,
    allowedTools: readonly ToolName[],
    spentUsd: number,
  ): Promise<string> {
    hooks.onWarn(
      `запущен субагент «${def.name}»: инструменты ${allowedTools.join(', ') || '(нет)'} — ` +
        'пересечение прав этапа и объявленных прав субагента',
    );

    const result = await this.run(
      {
        ...req,
        prompt: {
          presetNote: null,
          // Тело агента — его системный промпт, задача приходит пользовательским
          // сообщением. Рассказ вызывающего о своей работе сюда НЕ попадает: рецензент не
          // должен получать версию автора.
          system: def.prompt,
          user: task,
          tools: [],
          editedByOperator: false,
        },
        // Модель субагента, если он её назвал: рецензент бывает сильнее исполнителя.
        model: def.model ?? req.model,
        allowedTools,
        subagents: [],
        // Свой потолок ходов: вложенный прогон не должен съесть бюджет этапа целиком.
        maxTurns: Math.max(4, Math.floor(req.maxTurns / 2)),
        // Бюджет ОБЩИЙ с родителем: свой полный потолок у каждого субагента означал бы,
        // что объявленный лимит витка умножается на число вложенных прогонов.
        spentUsdBefore: spentUsd,
      },
      hooks,
    );

    if (!result.ok) {
      // Провал субагента не выдаётся за успех: иначе несостоявшееся ревью зажгло бы гейт.
      throw new SubagentUnavailable(`субагент «${def.name}» не завершил работу: ${result.note}`);
    }
    return result.finalText === ''
      ? `субагент «${def.name}» вернул пустой ответ`
      : result.finalText;
  }

  private async execute(
    call: NormalizedCall,
    req: ExecRequest,
    hooks: ExecHooks,
    toolCtx: ToolContext,
    /** Уже потрачено на витке — вложенный прогон субагента делит потолок с родителем. */
    spentUsd: number,
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

      case 'request_scope_extension':
        // Само расширение `plan.md` и пересчёт политики уже произошли в `onToolRequest`
        // ДО того, как этот вызов дошёл сюда: `execute()` зовётся только после `decision.
        // allowed`. Здесь только подтверждение модели, что путь теперь можно писать.
        return `«${call.path}» добавлен в files_to_touch — теперь его можно писать`;

      case 'subagent': {
        // Субагент — вложенный прогон ТОГО ЖЕ цикла с урезанными правами.
        //
        // Отсутствие субагента по-прежнему отдаётся ОШИБКОЙ, а не текстом: успешный исход
        // здесь засчитывается как состоявшееся ревью и зажигает обязательный гейт, поэтому
        // «сделал вид, что позвал» — это ложный зелёный на самом сторожевом месте.
        const def = req.subagents.find((a) => a.name === call.agent);
        if (def === undefined) {
          const declared = req.subagents.map((a) => a.name).join(', ');
          const note =
            `субагент «${call.agent}» на этом этапе не объявлен` +
            (declared === '' ? '' : ` (объявлены: ${declared})`) +
            '. Вызвать можно только объявленного: права субагента заданы конструкцией.';
          hooks.onWarn(note);
          throw new SubagentUnavailable(note);
        }

        // Права — ПЕРЕСЕЧЕНИЕ прав этапа и объявленных прав субагента. Ни расширить права
        // этапа вызовом субагента, ни выдать субагенту больше, чем он объявил, нельзя;
        // это пересечение доезжает до политики через `callerTools` в `onToolRequest` —
        // на списке инструментов для модели оно бы держалось только на её послушании.
        // `tools: null` — строки в файле нет, то есть агент наследует права этапа.
        const declaredTools =
          def.tools === null ? null : def.tools.filter((t): t is ToolName => isToolName(t));
        const nested =
          declaredTools === null
            ? req.allowedTools
            : req.allowedTools.filter((t) => declaredTools.includes(t));

        // Прогон без единого инструмента — не ревью. Раньше он завершался «успешно» и
        // зажигал гейт «Ревью независимым агентом» отчётом, сочинённым вслепую.
        if (nested.length === 0) {
          const note =
            `субагент «${def.name}» не получил ни одного инструмента: пересечение прав ` +
            `этапа (${req.allowedTools.join(', ') || '—'}) и объявленных им ` +
            `(${(declaredTools ?? []).join(', ') || '—'}) пусто. Прогон вслепую ревью не является.`;
          hooks.onWarn(note);
          throw new SubagentUnavailable(note);
        }

        return this.runSubagent(req, hooks, def, call.prompt, nested, spentUsd);
      }

      default: {
        const outcome = await executeTool(call, toolCtx);
        return outcome.ok ? outcome.text : `ошибка: ${outcome.text}`;
      }
    }
  }
}
