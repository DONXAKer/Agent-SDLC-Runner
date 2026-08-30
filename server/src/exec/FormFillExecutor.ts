/**
 * Флоу `loop`, режим «заполнение бланка по полям» — для этапов-документов (intent/ask/plan).
 *
 * Зачем: замеры (`docs/model-runs.md`) показали, что у моделей ≤9B порог «позвать
 * инструмент» лежит НИЖЕ порога «понять задачу»: qwen2.5-coder — 0 вызовов за 892 с,
 * qwen3.5 — три круга вопросов вместо записи. Этап-документ по существу — заполнение
 * разложенного рантаймом бланка, и tool-use для этого не обязателен: рантайм сам находит
 * плейсхолдеры `‹…›`, спрашивает модель ПО ОДНОМУ полю обычным completion'ом и сам
 * записывает результат. Порог «позвать инструмент» исчезает по построению.
 *
 * Поля ищутся и заменяются через `placeholderRanges` — ТО ЖЕ определение плейсхолдера,
 * которым считает готовность `readArtifact`: упоминание `‹…›` в инлайн-коде и цитатах
 * полем не является (первая версия с наивным `includes('‹')` перезаписывала строку-легенду
 * шаблона сочинённым содержимым). Заменяется только сам диапазон плейсхолдера, не строка
 * целиком — структура вокруг (ячейки таблиц, жирные метки) остаётся нетронутой.
 *
 * Что тут НЕ обходится:
 *  - **Гейт одобрения и политика.** Собранный артефакт уходит через `hooks.onToolRequest`
 *    нормализованным `Write` — тот же путь, что у salvage: политика решает, оператор
 *    одобряет, второго места решения о доступе не появляется.
 *  - **Страж завершения.** Поле, которое модель не смогла заполнить, остаётся
 *    плейсхолдером, и `finishGuard`/предусловия следующего этапа честно краснеют.
 *
 * Ограничение режима: `AskHuman` здесь нет — вопросы человеку требуют цикла. Поле,
 * требующее решения человека, модель обязана оставить с пометкой, а не сочинить; это
 * режим ЭКСПЕРИМЕНТА для слабых моделей (флаг `formFill` записи модели), а не замена
 * штатного цикла.
 */

import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';

import type { Usage } from '@sdlc-runner/shared';
import { addUsage, emptyUsage, money } from '@sdlc-runner/shared';

import { placeholderRanges, readArtifact } from '../artifacts/artifact.ts';
import type { ChatProvider } from '../provider/ChatProvider.ts';
import { normalize } from './normalize.ts';
import type { ExecHooks, ExecRequest, StageExecutor, StageResult } from './StageExecutor.ts';
import { executeTool, type ToolContext } from './tools/index.ts';

/**
 * Сколько полей спрашивается одновременно. Поля независимы (каждый запрос несёт полный
 * контекст и одну строку бланка), 3 — компромисс: заметно быстрее последовательного, но
 * не шторм для локального сервера, который всё равно исполняет запросы по одному.
 */
const FIELD_PARALLEL = 3;

export interface FormFillOptions {
  provider: ChatProvider;
  maxResultBytes: number;
  readRangeRequiredAboveBytes: number;
  bashTimeoutMs: number;
  /** Параметры запроса из конфига модели (`ModelDef.params`). */
  params?: Record<string, unknown> | null;
  /** Валюта провайдера маршрута — для честной подписи трат. Умолчание USD. */
  currency?: string;
}

/**
 * Ответ модели — текст, которым заменяется плейсхолдер. Снимаются только обёртки,
 * которые модель добавляет «из вежливости» (fenced-блок, внешние кавычки) — содержимое
 * не редактируется: редактировать ответ значило бы сочинять артефакт за модель.
 */
export function cleanFieldAnswer(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fence !== null) text = fence[1]!.trim();
  if (text.startsWith('«') && text.endsWith('»')) text = text.slice(1, -1).trim();
  return text;
}

/** Поле бланка: одиночный плейсхолдер либо строка-образец таблицы целиком. */
export interface FormField {
  start: number;
  end: number;
  /** `cell` — заменяется сам плейсхолдер; `row` — вся строка-образец, ответ может быть несколькими строками. */
  kind: 'cell' | 'row';
  /** Текст плейсхолдера (`cell`) либо строка-образец (`row`) — уходит в подсказку модели. */
  text: string;
}

/**
 * Плейсхолдеры → поля. Строка ТАБЛИЦЫ с плейсхолдерами схлопывается в одно поле-строку:
 * это образец, один на весь будущий список, и несколько его плейсхолдеров — не несколько
 * независимых полей, а колонки одного элемента. Списки с маркером `-` сюда не входят:
 * `- **Ветка витка:** ‹…›` — обычное поле с меткой, а не образец списка.
 */
export function groupFields(text: string): FormField[] {
  const out: FormField[] = [];
  let lastRowStart = -1;
  for (const r of placeholderRanges(text)) {
    const lineStart = text.lastIndexOf('\n', r.start - 1) + 1;
    const lineEndIdx = text.indexOf('\n', r.start);
    const lineEnd = lineEndIdx < 0 ? text.length : lineEndIdx;
    const line = text.slice(lineStart, lineEnd);
    if (line.trimStart().startsWith('|')) {
      if (lineStart === lastRowStart) continue; // колонка того же образца — уже учтён
      lastRowStart = lineStart;
      out.push({ start: lineStart, end: lineEnd, kind: 'row', text: line });
    } else {
      out.push({ start: r.start, end: r.end, kind: 'cell', text: r.text });
    }
  }
  return out;
}

/** Строка текста, содержащая позицию `index`, — контекст поля для модели. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? text.length : end);
}

/**
 * Секция бланка от последнего заголовка до строки-образца включительно — контекст поля-строки.
 *
 * Одной строки-образца мало: правила списка живут в легенде секции над таблицей
 * («граничные случаи помечаются тегом [edge]», формат id), и модель, видевшая только
 * строку, писала лист без единой [edge]-пометки — минимум методологии ронял этап
 * (живой прогон, 7 пунктов и 0 [edge] при норме ≥2).
 */
function sectionAt(text: string, index: number, maxBytes = 2500): string {
  const lineEndIdx = text.indexOf('\n', index);
  const end = lineEndIdx < 0 ? text.length : lineEndIdx;
  const heading = text.lastIndexOf('\n#', index);
  let start = heading < 0 ? 0 : heading + 1;
  let section = text.slice(start, end);
  while (Buffer.byteLength(section, 'utf8') > maxBytes) {
    // Режем сверху: строка-образец и ближняя легенда важнее начала секции.
    const cut = section.indexOf('\n', Math.floor(section.length / 4));
    if (cut < 0) break;
    section = section.slice(cut + 1);
  }
  return section;
}

export class FormFillExecutor implements StageExecutor {
  readonly flow = 'loop' as const;
  private readonly o: FormFillOptions;

  constructor(o: FormFillOptions) {
    this.o = o;
  }

  async run(req: ExecRequest, hooks: ExecHooks): Promise<StageResult> {
    const artifacts = req.formArtifacts ?? [];
    if (artifacts.length === 0) {
      return {
        ok: false,
        finalText: '',
        usage: emptyUsage(),
        note: 'режим заполнения по полям: этап не назвал артефактов — исполнять нечего',
      };
    }

    const toolCtx: ToolContext = {
      projectRoot: req.cwd,
      maxResultBytes: this.o.maxResultBytes,
      readRangeRequiredAboveBytes: this.o.readRangeRequiredAboveBytes,
      timeoutMs: this.o.bashTimeoutMs,
      signal: req.signal,
    };
    const currency = this.o.currency ?? 'USD';

    let usage: Usage = emptyUsage();
    let fieldsFilled = 0;
    let fieldsLeft = 0;
    let callsSpent = 0;
    const notes: string[] = [];

    for (const path of artifacts) {
      if (req.signal.aborted) return { ok: false, finalText: '', usage, note: 'этап отменён' };

      const artifact = readArtifact(path);
      if (!artifact.exists) {
        // Бланк не разложен — это дефект посева, а не модели: пропускаем с пометкой,
        // страж завершения назовёт незаписанный артефакт сам.
        notes.push(`бланк ${path} не найден — рантайм его не разложил`);
        continue;
      }

      let text = artifact.text;
      // С конца к началу: сплайс не сдвигает позиции ещё не обработанных диапазонов.
      // Поля считаются НЕ по одному плейсхолдеру: строка таблицы с плейсхолдерами — это
      // строка-ОБРАЗЕЦ, одна на весь будущий список (пункты приёмки, вопросы), и спрошенная
      // «по одному полю» она давала список из одного пункта — сквозной прогон дважды встал
      // на «приёмочный лист короче минимума» у двух разных моделей. Такая строка
      // заполняется целиком, ответ может быть НЕСКОЛЬКИМИ строками того же формата.
      const ranges = groupFields(text).reverse();
      let changed = false;

      // Поля независимы и идут пачками: последовательное дозаполнение журнала занимало
      // ~40 с чистого ожидания сети на десяток полей. Ответы собираются на НЕИЗМЕНЁННОМ
      // тексте (позиции и строки всех полей пачки посчитаны до первого сплайса), сплайсы
      // применяются после пачки — в том же порядке «с конца», что и раньше.
      for (let batchStart = 0; batchStart < ranges.length; batchStart += FIELD_PARALLEL) {
        if (req.signal.aborted) return { ok: false, finalText: '', usage, note: 'этап отменён' };

        // Потолок вызовов — тот же лимит ходов этапа: поле дешевле хода, но безлимитный
        // бланк на сотню плейсхолдеров съел бы больше, чем обычный цикл.
        const allowed = Math.min(FIELD_PARALLEL, req.maxTurns - callsSpent);
        const batch = ranges.slice(batchStart, batchStart + FIELD_PARALLEL);
        if (allowed <= 0) {
          fieldsLeft += batch.length;
          continue;
        }
        const asked = batch.slice(0, allowed);
        fieldsLeft += batch.length - asked.length;
        callsSpent += asked.length;

        const answers = await Promise.all(
          asked.map((range) =>
            this.o.provider.chat({
              model: req.model,
              messages: [
                { role: 'system', content: req.prompt.system },
                {
                  role: 'user',
                  content: [
                    req.prompt.user,
                    '',
                    '## Сейчас — ровно одно поле',
                    '',
                    range.kind === 'row'
                      ? `Файл \`${relative(req.cwd, path)}\`, секция бланка (последняя строка — образец):`
                      : `Файл \`${relative(req.cwd, path)}\`, строка бланка:`,
                    '',
                    '```',
                    range.kind === 'row' ? sectionAt(text, range.start) : lineAt(text, range.start),
                    '```',
                    '',
                    range.kind === 'row'
                      ? 'Последняя строка секции — ОБРАЗЕЦ строки таблицы, один на весь список. ' +
                        'Верни заполненные строки таблицы того же формата — столько, сколько ' +
                        'нужно по факту задачи и входных артефактов (каждая начинается с `|`), ' +
                        'без скобок ‹› и без пояснений вокруг. Соблюдай правила легенды секции — ' +
                        'обязательные теги (например `[edge]` в нужной колонке) и формат id. ' +
                        'Если по задаче элемент ровно один — верни одну строку.'
                      : `Верни ТОЛЬКО текст, которым надо заменить плейсхолдер \`${range.text}\` в этой ` +
                        'строке — без самих скобок ‹›, без пояснений вокруг, по факту задачи и входных ' +
                        'артефактов. Если поле требует решения человека, которого у тебя нет, верни ' +
                        '«требует решения человека: <что именно>» вместо выдуманного ответа.',
                  ].join('\n'),
                },
              ],
              tools: [],
              signal: req.signal,
              temperature: null,
              params: this.o.params ?? null,
            }),
          ),
        );

        for (const answer of answers) {
          usage = addUsage(usage, answer.usage);
          hooks.onUsage(answer.usage);
        }

        // Бюджет проверяется после пачки: цена известна только по факту, а пачка — это
        // и есть один «ход» режима.
        const spent = usage.costUsd === null ? null : usage.costUsd + (req.spentUsdBefore ?? 0);
        if (req.maxBudgetUsd !== null && spent !== null && spent >= req.maxBudgetUsd) {
          return {
            ok: false,
            finalText: '',
            usage,
            note:
              `бюджет прогона исчерпан: ${money(spent, currency)} из ` +
              `${money(req.maxBudgetUsd, currency)}`,
          };
        }

        // Сплайсы после пачки, в её же порядке «с конца»: позиции необработанных
        // диапазонов ниже по тексту не сдвигаются.
        for (const [idx, range] of asked.entries()) {
          let filled = cleanFieldAnswer(answers[idx]?.text ?? '');
          // Из ответа на строку-образец берутся ТОЛЬКО строки таблицы: живой прогон
          // показал ответ «```markdown …таблица… ``` **Обоснование:** …» — валидная
          // таблица внутри мусора вежливости, и требование «весь ответ — строки таблицы»
          // отклоняло её целиком. Продублированные шапка и разделитель тоже снимаются;
          // содержимое самих строк не редактируется. Ни одной строки — поле не заполнено.
          if (range.kind === 'row') {
            const rows = filled
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l.startsWith('|') && !/^\|[\s:|-]+\|$/.test(l))
              .filter((l, i2, all) => !(i2 === 0 && all.length > 1 && /\|\s*id\s*\|/i.test(l)));
            filled = rows.join('\n');
          }
          // Пустой ответ и ответ с плейсхолдером полем не считаются: диапазон остаётся как
          // был, и его честно назовут страж завершения и предусловие следующего этапа.
          if (filled === '' || filled.includes('‹')) {
            fieldsLeft++;
            continue;
          }
          text = text.slice(0, range.start) + filled + text.slice(range.end);
          fieldsFilled++;
          changed = true;
        }
      }

      if (!changed) continue;

      // Запись — тем же путём, что любая запись исполнителя: нормализованный Write через
      // гейт. Отказ политики или оператора здесь окончательный — второй попытки с другим
      // путём у режима нет по построению.
      const rel = relative(req.cwd, path);
      const rawInput = { file_path: rel, content: text };
      const call = normalize('Write', rawInput);
      const requestId = `form:${randomUUID()}`;
      const decision = await hooks.onToolRequest(call, {
        requestId,
        toolName: 'Write',
        rawInput,
        callerTools: req.allowedTools,
      });
      if (!decision.allowed) {
        hooks.onFriction('denied');
        hooks.onToolResult({ requestId, ok: false, summary: decision.reason, durationMs: 0 });
        notes.push(`запись ${rel} отклонена: ${decision.reason}`);
        continue;
      }
      const effective =
        decision.updatedInput === null
          ? call
          : normalize('Write', decision.updatedInput as Record<string, unknown>);
      const outcome = await executeTool(effective, toolCtx);
      hooks.onToolResult({
        requestId,
        ok: outcome.ok,
        summary: outcome.text.split('\n')[0]?.slice(0, 200) ?? '',
        durationMs: 0,
      });
      if (!outcome.ok) notes.push(`запись ${rel} не удалась: ${outcome.text}`);
    }

    // «Заполнено в тексте» — не «записано на диск»: отклонённая гейтом запись оставляет
    // бланк нетронутым, и сводка обязана это различать, а не отчитываться сделанным.
    const summary =
      `заполнение по полям: в тексте заполнено ${fieldsFilled}, осталось ${fieldsLeft}` +
      (notes.length === 0 ? '; записано через гейт' : `; ${notes.join('; ')}`);
    hooks.onText(summary);

    // Последнее слово — за диском, как и в обычном цикле: страж смотрит артефакты, а не
    // наш счётчик полей.
    const complaint = req.finishGuard === null ? null : req.finishGuard();
    if (complaint !== null) {
      return { ok: false, finalText: summary, usage, note: complaint };
    }
    return { ok: true, finalText: summary, usage, note: summary };
  }
}
