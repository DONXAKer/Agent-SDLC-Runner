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
import { isAbsolute, join } from 'node:path';

import type { NormalizedCall, ToolName, Usage } from '@sdlc-runner/shared';
import { addUsage, emptyUsage, money } from '@sdlc-runner/shared';

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
import { isToolName, specsFor } from './toolSpecs.ts';
import { readArtifact } from '../artifacts/artifact.ts';

export interface LoopOptions {
  provider: ChatProvider;
  maxResultBytes: number;
  readRangeRequiredAboveBytes: number;
  bashTimeoutMs: number;
  /** `null` — не задавать серверу температуру вовсе. */
  temperature: number | null;
  /** Параметры запроса из конфига модели (`ModelDef.params`). Не заданы — не шлём. */
  params?: Record<string, unknown> | null;
  /** Валюта провайдера маршрута — для честной подписи трат в нотах. Умолчание USD. */
  currency?: string;
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
 * Алиасы моделей Claude Code в frontmatter определений субагентов (`model: opus`).
 * Определения написаны для реализации claude-code; OpenAI-совместимому провайдеру такой
 * алиас неизвестен и падает «модель не найдена» — на verify это валило рецензента.
 */
const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'inherit']);

/**
 * Сколько раз напоминаем про незаписанный артефакт, прежде чем признать этап неудавшимся.
 *
 * Два, а не «пока не сделает»: модель, которая не поняла с двух напоминаний, не поймёт и с
 * десятого, а ходы стоят времени оператора.
 */
const FINISH_REMINDERS = 2;

/**
 * Сколько чтений подряд без единой записи терпим молча.
 *
 * Замер этапа 5 (`docs/model-runs.md`, bench `oversize`): 8 вызовов за этап — все чтение,
 * 121 926 входных токенов сгорели, дерево не изменилось ни на строку. Модель не «думает» —
 * она застряла ниже порога «записать»; напоминание в этот момент дешевле, чем сгоревший
 * этап. Два напоминания, дальше молчим: та же логика, что у `FINISH_REMINDERS`.
 */
const READ_STREAK_LIMIT = 5;
const READ_STREAK_REMINDERS = 2;

/** Виды вызовов, которые продлевают серию «только чтение». Всё прочее серию сбрасывает. */
const READ_KINDS = new Set(['read', 'glob', 'grep']);

/**
 * Та же конструкция для серий оболочки. Замер (`docs/model-runs.md`, ministral-14b t=0):
 * 14 Bash подряд за прогон — модель гоняет команды вместо правок, и каждый ход несёт
 * полный промпт по счётчику входных токенов. Порог выше читального: две команды подряд
 * (тест + сборка) — штатный ритм, серия из четырёх — уже блуждание.
 */
const BASH_STREAK_LIMIT = 4;
const BASH_STREAK_REMINDERS = 2;

/** Опросный ли это инструмент — по шаблонам из конфига сервера. */
function isPolling(toolName: string, req: ExecRequest): boolean {
  const patterns = req.mcp?.pollingTools ?? [];
  return patterns.some((p) =>
    p.endsWith('*') ? toolName.startsWith(p.slice(0, -1)) : toolName.endsWith(p),
  );
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

    const tools = [
      ...specsFor(req.allowedTools).map((s) => ({
        // Во флоу `loop` имена наши: MCP-префикса здесь нет, и подсовывать модели
        // `mcp__sdlc__ask_human` значило бы описывать несуществующий транспорт.
        name: s.name,
        description: s.description,
        schema: s.schema,
      })),
      // А вот у ВНЕШНИХ серверов транспорт здесь настоящий, и имя у них одно на оба флоу:
      // `mcp__<сервер>__<инструмент>`. Набор приходит уже отобранным — считать его второй
      // раз внутри исполнителя значило бы показать оператору не то, что уходит в модель.
      ...(req.mcp?.tools ?? []),
    ];

    const messages: ChatMessage[] = [
      { role: 'system', content: req.prompt.system },
      { role: 'user', content: req.prompt.user },
    ];

    let usage: Usage = emptyUsage();
    let finalText = '';
    let lastFingerprint: string | null = null;
    let repeats = 0;
    /** Сколько работы было зафиксировано, когда началась текущая серия повторов. */
    let progressAtStreakStart = req.progressSignal?.() ?? 0;
    let reminders = 0;
    let readStreak = 0;
    let readNudges = 0;
    let bashStreak = 0;
    let bashNudges = 0;

    /**
     * Исход этапа считается по диску, а не по поведению модели: анти-цикл, сработавший
     * при готовом артефакте, ронял готовый этап. Живой прогон r17d: coder-next успешно
     * заявила отчёт разведки готовым и повторила FinalizeArtifact «для верности» —
     * этап падал красным при молчащем страже. `null` — работа НЕ готова, останов
     * анти-цикла остаётся красным (в том числе когда стража нет: без критерия
     * готовности зелёного по зацикливанию не бывает).
     */
    const finishedByDisk = (): StageResult | null => {
      if (req.finishGuard === null || req.finishGuard() !== null) return null;
      const note = 'цикл остановлен повтором вызова, но артефакт готов — этап закрыт по диску';
      hooks.onWarn(note);
      return { ok: true, finalText, usage, note };
    };

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
        params: this.o.params ?? null,
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
        // Сравниваются числа В ВАЛЮТЕ ПРОВАЙДЕРА (usage.cost приходит как есть, без
        // пересчёта) — потолок проекта задаётся в ней же, и подпись обязана совпадать:
        // «$4.09 из $4» на рублёвом агрегаторе завышал трату ~в 90 раз.
        const cur = this.o.currency ?? 'USD';
        const note = `бюджет прогона исчерпан: ${money(spent, cur)} из ${money(req.maxBudgetUsd, cur)}`;
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
        // «Завершила ход» — не то же самое, что «сделала работу». Пока артефакт этапа не
        // на диске, ход не закончен, и это проверяется, а не выспрашивается у модели.
        if (done && req.finishGuard !== null) {
          let complaint = req.finishGuard();

          // Модель напечатала содержимое артефакта вместо того, чтобы его записать. Это
          // не редкость и не ошибка формата: на всех замеренных локальных моделях именно
          // здесь ход и сгорал. Спасение идёт ДО напоминания — напоминать о том, что уже
          // написано в этом же ответе, значит гонять модель по кругу за свой счёт.
          if (complaint !== null && req.salvageFromText !== null) {
            const saved = await req.salvageFromText(answer.text);
            if (saved !== null) {
              hooks.onWarn(saved);
              complaint = req.finishGuard();
            }
          }

          if (complaint !== null && reminders < FINISH_REMINDERS) {
            reminders++;
            hooks.onFriction('reminder');
            hooks.onWarn(`${complaint} (напоминание ${reminders} из ${FINISH_REMINDERS})`);
            messages.push({ role: 'assistant', content: answer.text, toolCalls: [] });
            messages.push({ role: 'user', content: complaint });
            continue;
          }
          if (complaint !== null) {
            return { ok: false, finalText, usage, note: complaint };
          }
        }

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

      // Ход из субагентов — прогресс, не чтение: серия сбрасывается и здесь, иначе
      // напоминание «пора писать» прилетало бы сразу после хода, где модель делегировала.
      if (parallelSubagents) {
        readStreak = 0;
        bashStreak = 0;
      }

      if (parallelSubagents) {
        // Отпечаток хода целиком, а не последнего вызова: пока `repeats` здесь обнулялся
        // безусловно, модель, повторяющая одну и ту же пару `Task`, крутилась до
        // `maxTurns`, и каждый ход стоил двух полных вложенных прогонов.
        const turnFingerprint = answer.toolCalls.map(callFingerprint).join(' ');
        repeats = turnFingerprint === lastFingerprint ? repeats + 1 : 0;
        lastFingerprint = turnFingerprint;
        if (repeats > 0) hooks.onFriction('repeat');

        if (repeats + 1 >= REPEAT_LIMIT) {
          const doneAnyway = finishedByDisk();
          if (doneAnyway !== null) return doneAnyway;
          const note =
            `цикл остановлен: ход из ${answer.toolCalls.length} субагентов повторён ` +
            `${repeats + 1} раза подряд с теми же аргументами — прогресса нет`;
          hooks.onWarn(note);
          return { ok: false, finalText, usage, note };
        }

        const spentNow = (usage.costUsd ?? 0) + (req.spentUsdBefore ?? 0);
        const results = await Promise.all(
          answer.toolCalls.map((call) =>
            this.handleCall(call, normalize(call.name, call.arguments ?? {}), 0, req, hooks, toolCtx, spentNow),
          ),
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
        if (repeats === 0) progressAtStreakStart = req.progressSignal?.() ?? 0;

        if (repeats > 0 && !isPolling(call.name, req)) hooks.onFriction('repeat');

        if (repeats + 1 >= REPEAT_LIMIT && !isPolling(call.name, req)) {
          const doneAnyway = finishedByDisk();
          if (doneAnyway !== null) return doneAnyway;

          // Работа за время серии прибавилась — значит модель не буксует, а повторяет
          // вызов рядом с делом. Обрывать здесь значит терять этап, в котором результат
          // уже накоплен: ровно так дважды терялся этап 6 ПОСЛЕ прогона гейтов.
          const progressNow = req.progressSignal?.() ?? 0;
          if (progressNow > progressAtStreakStart) {
            hooks.onWarn(
              `«${call.name}» повторён ${repeats + 1} раза подряд, но с начала серии ` +
                `зафиксировано ${progressNow - progressAtStreakStart} новых результат(ов) — ` +
                `этап продолжается, повторный вызов не исполняется`,
            );
            repeats = 0;
            progressAtStreakStart = progressNow;
          } else {
            const note =
              `цикл остановлен: «${call.name}» вызван ${repeats + 1} раза подряд с теми же ` +
              `аргументами — прогресса нет`;
            hooks.onWarn(note);
            return { ok: false, finalText, usage, note };
          }
        }

        // Нормализация один раз на вызов: она же нужна серии чтений ниже, а `handleCall`
        // до появления счётчика разбирал вызов вторым заходом на том же горячем пути.
        const normalized = call.arguments === null ? null : normalize(call.name, call.arguments);

        // Серия «только чтение» считается по виду вызова, а не по имени инструмента:
        // нормализация одна на оба флоу, второй список читающих имён разошёлся бы с ней.
        // Обновление стоит ДО исполнения: отклонённый политикой или повторный вызов —
        // тоже не запись, и серия сквозь него не обнуляется.
        readStreak =
          normalized !== null && READ_KINDS.has(normalized.kind) ? readStreak + 1 : 0;
        bashStreak = normalized !== null && normalized.kind === 'bash' ? bashStreak + 1 : 0;

        const result = await this.handleCall(
          call,
          normalized,
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

      // Напоминание идёт ПОСЛЕ результатов инструментов хода: user-сообщение между
      // assistant-ходом и его tool-результатами часть серверов отвергает как нарушение
      // протокола. Только для этапов с артефактом: субагенту-читателю (locator, reviewer
      // до отчёта) серия чтений — законный режим работы.
      if (
        req.finishGuard !== null &&
        readStreak >= READ_STREAK_LIMIT &&
        readNudges < READ_STREAK_REMINDERS
      ) {
        const streak = readStreak;
        readNudges++;
        readStreak = 0;
        hooks.onFriction('reminder');
        messages.push({
          role: 'user',
          content:
            `Последние ${streak} вызовов — только чтение (Read/Glob/Grep), ни одной ` +
            'записи. Результат этапа — записанный артефакт, а не прочитанные файлы: если ' +
            'контекста уже достаточно, переходи к записи инструментами Write/Edit. Продолжай ' +
            'читать только то, без чего правку не сделать.',
        });
      }

      // Серия оболочки — тем же местом и по тем же правилам, что серия чтений.
      if (
        req.finishGuard !== null &&
        bashStreak >= BASH_STREAK_LIMIT &&
        bashNudges < BASH_STREAK_REMINDERS
      ) {
        const streak = bashStreak;
        bashNudges++;
        bashStreak = 0;
        hooks.onFriction('reminder');
        messages.push({
          role: 'user',
          content:
            `Последние ${streak} вызовов — только Bash. Этап делается правками файлов ` +
            '(Write/Edit) и записью артефакта, а не командной строкой: запусти проверку один ' +
            'раз ПОСЛЕ правки, вместо серии команд до неё. Каждый ход стоит полного промпта.',
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
    /** Уже нормализованный вызов — считается один раз в цикле; `null` при сломанном JSON. */
    normalized: NormalizedCall | null,
    repeats: number,
    req: ExecRequest,
    hooks: ExecHooks,
    toolCtx: ToolContext,
    /** Уже потрачено на витке к моменту вызова — передаётся вложенному прогону субагента. */
    spentUsd: number,
  ): Promise<string> {
    const started = Date.now();
    const requestId = `loop:${randomUUID()}`;

    if (call.arguments === null || normalized === null) {
      // Не падаем: говорим, что именно не разобралось. Модель, которой сказали «ошибка»
      // без подробностей, повторяет ту же строку.
      const text = `аргументы не разобрались как JSON: ${call.rawArguments.slice(0, 300)}`;
      hooks.onFriction('badJson');
      hooks.onToolResult({ requestId, ok: false, summary: text, durationMs: 0 });
      return text;
    }

    // Опросный инструмент повторяется законно: `pie_status` и `wait_for_*` для того и
    // существуют, чтобы звать их подряд, пока редактор не догрузится. Замечание вместо
    // результата здесь означало бы, что ожидание невозможно в принципе.
    if (repeats > 0 && !isPolling(call.name, req)) {
      const text =
        `этот вызов уже был с теми же аргументами и дал тот же результат. Он не повторён. ` +
        `Смени подход: либо другой инструмент, либо другие аргументы, либо заверши ход.`;
      hooks.onToolResult({ requestId, ok: false, summary: 'повторный вызов', durationMs: 0 });
      return text;
    }

    const decision = await hooks.onToolRequest(normalized, {
      requestId,
      toolName: call.name,
      rawInput: call.arguments,
      // Права текущего вызывающего, а не этапа: во вложенном прогоне субагента здесь
      // уже суженный список, и политика решает по нему.
      callerTools: req.allowedTools,
    });
    if (!decision.allowed) {
      hooks.onFriction('denied');
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

    // Метка обрезки ставится в `cap` — единственном месте, которое знает лимит. Ловим её
    // по ней же: считать длину второй раз значило бы завести второе знание о потолке.
    if (text.includes('[рантайм обрезал:')) hooks.onFriction('truncated');

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
  /** Модель вложенного прогона: своя у субагента, если это не алиас чужого флоу. */
  private subagentModel(def: SubagentDef, req: ExecRequest, hooks: ExecHooks): string {
    if (def.model === null || def.model === undefined) return req.model;
    if (CLAUDE_MODEL_ALIASES.has(def.model)) {
      hooks.onWarn(
        `модель «${def.model}» из определения субагента «${def.name}» — алиас Claude Code, ` +
          'флоу loop им не пользуется: субагент идёт на модели этапа',
      );
      return req.model;
    }
    return def.model;
  }

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
        // Но алиасы Claude Code — имена ЧУЖОГО флоу: определения агентов написаны для
        // claude-code, и `model: opus`, отданный OpenAI-совместимому провайдеру буквально,
        // падал «Модель "opus" не найдена» ровно на рецензенте — самом сторожевом месте.
        // Алиас игнорируется с предупреждением: маршрут verify уже выбран профилем, и
        // правило «рецензент сильнее исполнителя» держит он, а не строка определения.
        model: this.subagentModel(def, req, hooks),
        allowedTools,
        subagents: [],
        // Страж завершения — про артефакт ЭТАПА, а его пишет вызывающий, не субагент:
        // `sdlc-locator` вообще не имеет прав записи, и требовать с него файл значило бы
        // обрывать вложенный прогон за чужую недоделку.
        finishGuard: null,
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

      case 'finalize_artifact': {
        // Заявка «готово» проверяется ЗДЕСЬ, а не только предусловием следующего этапа:
        // слабая модель финализирует шаблон с плейсхолдерами и честно считает работу
        // сделанной (наблюдалось трижды подряд на живом витке — журнал chunk'а уходил
        // «готовым» нетронутым). Замечание вместо результата — та же конструкция, что
        // у повторных вызовов: просьбам модель верит хуже, чем отказам инструмента.
        const p = isAbsolute(call.artifact) ? call.artifact : join(toolCtx.projectRoot, call.artifact);
        // Финализировать можно только артефакт ЭТАПА: путь приходит строкой от модели, и
        // читать по нему произвольный файл до всякой политики нельзя — тот же принцип,
        // что у превью («предпросмотр строится после разрешения»). Список этапных
        // артефактов рантайм уже передал в `formArtifacts`.
        const declared = req.formArtifacts ?? [];
        if (declared.length > 0 && !declared.includes(p)) {
          return (
            `ошибка: «${call.artifact}» не является артефактом этого этапа — финализируй ` +
            `один из: ${declared.map((d) => d).join(', ')}`
          );
        }
        const a = readArtifact(p);
        if (!a.exists) {
          return `ошибка: артефакт ${call.artifact} не существует — сначала запиши его, потом финализируй`;
        }
        if (a.placeholders > 0) {
          return (
            `ошибка: в ${call.artifact} осталось незаполненных мест ‹…›: ${a.placeholders} — ` +
            `финализировать нельзя. Прочитай артефакт, заполни каждый плейсхолдер по факту ` +
            `и вызови FinalizeArtifact снова`
          );
        }
        return `артефакт заявлен готовым: ${call.artifact}`;
      }

      // Записи в отчёт этапа 6 принимает рантайм — он же и рисует из них таблицу. Здесь
      // только передача: второго места, знающего форму отчёта, не заводим.
      case 'record_claim':
      case 'record_finding':
        return hooks.onRecord(call);

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

      case 'mcp': {
        // Исполнение здесь, а не в `executeTool`: тот получает только `ToolContext` —
        // диск, таймаут, сигнал — и по построению не знает ни про хаб, ни про хуки.
        // Ровно поэтому рядом живут `ask_human` и `subagent`.
        if (req.mcp === null) {
          return 'ошибка: внешние MCP-серверы на этом этапе не выданы';
        }
        const outcome = await req.mcp.call(call.server, call.tool, call.args, req.signal);
        return outcome.ok ? outcome.text : `ошибка: ${outcome.text}`;
      }

      default: {
        const outcome = await executeTool(call, toolCtx);
        return outcome.ok ? outcome.text : `ошибка: ${outcome.text}`;
      }
    }
  }
}
