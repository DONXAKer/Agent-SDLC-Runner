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
 *    нормализованным `Write` — тем же путём, что любая запись исполнителя (и что salvage):
 *    политика решает, оператор одобряет, второго места решения о доступе не появляется
 *    по построению. Отказ гейта окончательный — второй попытки записи у режима нет.
 *  - **Страж завершения.** Поле, которое модель не смогла заполнить, остаётся
 *    плейсхолдером, и `finishGuard`/предусловия следующего этапа честно краснеют.
 *  - **Решения человека.** Поля с жирными метками решений (`isDecisionLine`) и строки
 *    таблиц с подписной колонкой в шапке (`isDecisionCell`: «Утвердил», «Кто») модели не
 *    отдаются никогда — единый словарь меток живёт в `artifacts/artifact.ts`.
 *
 * Ограничение режима: `AskHuman` здесь нет — вопросы человеку требуют цикла. Поле,
 * требующее решения человека, модель обязана оставить с пометкой, а не сочинить; это
 * режим ЭКСПЕРИМЕНТА для слабых моделей (флаг `formFill` записи модели), а не замена
 * штатного цикла.
 *
 * ИМЕНОВАННОЕ ИСКЛЮЧЕНИЕ из правила «всё, что уйдёт в модель, собрано в buildPrompt»:
 * полевые до-запросы этого исполнителя добавляют к промпту этапа служебную обвязку
 * («ровно одно поле», секция-контекст, правила ответа-строки). Оператор видит промпт
 * этапа целиком; обвязка полей — конструкция режима, как adapter-блок, и меняется только
 * правкой кода, а не незаметной подстановкой данных.
 */

import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';

import type { Usage } from '@sdlc-runner/shared';
import { addUsage, emptyUsage, money } from '@sdlc-runner/shared';

import {
  isDecisionCell,
  isDecisionLine,
  lineAt,
  placeholderRanges,
  readArtifact,
} from '../artifacts/artifact.ts';
import { isSeparatorRow, splitRow } from '../md/table.ts';
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

/**
 * Поле бланка: одиночный плейсхолдер либо строка-образец таблицы целиком.
 * У `row` шапка обязательна ТИПОМ: необязательное поле с fallback'ом на сам образец
 * превращало бы ответ, совпавший с образцом, в «шапку» и молча выбрасывало (ревью-3).
 */
export type FormField =
  | {
      start: number;
      end: number;
      kind: 'cell';
      /** Текст плейсхолдера — уходит в подсказку модели. */
      text: string;
    }
  | {
      start: number;
      end: number;
      kind: 'row';
      /** Строка-образец целиком. */
      text: string;
      /** Шапка таблицы — для дедупа продублированной моделью шапки. */
      header: string;
    };

/** Первая строка элемента списка, которому принадлежит строка-продолжение с `lineStart`. */
function listItemFirstLine(text: string, lineStart: number): string {
  let start = lineStart;
  for (;;) {
    const prevEnd = start - 1;
    if (prevEnd < 0) break;
    const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
    const cur = text.slice(start, text.indexOf('\n', start) < 0 ? text.length : text.indexOf('\n', start));
    if (!/^\s+\S/.test(cur)) break; // дошли до первой строки элемента
    start = prevStart;
  }
  const end = text.indexOf('\n', start);
  return text.slice(start, end < 0 ? text.length : end);
}

/** Шапка таблицы, которой принадлежит строка с позиции `lineStart`: верхняя `|`-строка блока. */
function tableHeaderOf(text: string, lineStart: number): string {
  let start = lineStart;
  for (;;) {
    const prevEnd = start - 1;
    if (prevEnd < 0) break;
    const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
    const prev = text.slice(prevStart, prevEnd);
    if (!prev.trimStart().startsWith('|')) break;
    start = prevStart;
  }
  const end = text.indexOf('\n', start);
  return text.slice(start, end < 0 ? text.length : end);
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
  let lastRowEnd = -1;
  let lastHeader = '';
  for (const r of placeholderRanges(text)) {
    const lineStart = text.lastIndexOf('\n', r.start - 1) + 1;
    const lineEndIdx = text.indexOf('\n', r.start);
    const lineEnd = lineEndIdx < 0 ? text.length : lineEndIdx;
    const line = text.slice(lineStart, lineEnd);
    // Поле решения человека (жирная метка «**Подтвердил:**» и подобные) — не поле модели
    // ни в каком режиме. Живой прогон: модель заполнила «Подтвердил», строка перестала
    // быть полем решения, и запись настоящего решения упала «нет поля „Подтвердил“».
    // Строка-ПРОДОЛЖЕНИЕ элемента списка наследует его статус: длинное поле решения
    // переносится, и плейсхолдер ‹имя› живёт на строке без метки — ревью-4 воспроизвёл
    // это на живом handoff-шаблоне (фикс по одной строке был холостым).
    if (isDecisionLine(line)) continue;
    if (/^\s+\S/.test(line) && isDecisionLine(listItemFirstLine(text, lineStart))) continue;
    if (line.trimStart().startsWith('|')) {
      if (lineStart === lastRowStart) continue; // колонка того же образца — уже учтён
      // Шапка блока не пересчитывается для соседних строк той же таблицы: обход вверх на
      // каждую строку давал квадрат на больших таблицах (ревью-2). Кэш корректен, потому
      // что смежные placeholder-строки всегда принадлежат одной таблице: между таблицами
      // стоят шапка и разделитель, а они placeholder-строками не бывают.
      const header =
        lastRowEnd >= 0 && lineStart === lastRowEnd + 1 ? lastHeader : tableHeaderOf(text, lineStart);
      lastRowStart = lineStart;
      lastRowEnd = lineEnd;
      lastHeader = header;
      // В таблицах подпись человека живёт в ШАПКЕ, не в строке: образец под колонкой
      // «Утвердил (человек)» / «Кто» — поле решения, модель его не заполняет (сфабрикованная
      // подпись снимала бы ⏭ в вердикте). Отбрасывается вся строка-образец: заполнять
      // нерешенческие ячейки, оставляя подписную, значило бы учить модель дописывать
      // таблицу решений — принятая цена безопасности.
      if (splitRow(header).some(isDecisionCell)) continue;
      out.push({ start: lineStart, end: lineEnd, kind: 'row', text: line, header });
    } else {
      out.push({ start: r.start, end: r.end, kind: 'cell', text: r.text });
    }
  }
  return out;
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
  const start = heading < 0 ? 0 : heading + 1;
  let section = text.slice(start, end);
  while (Buffer.byteLength(section, 'utf8') > maxBytes) {
    // Режем сверху: строка-образец и ближняя легенда важнее начала секции.
    const cut = section.indexOf('\n', Math.floor(section.length / 4));
    if (cut < 0) break;
    section = section.slice(cut + 1);
  }
  return section;
}

/** Каноничный вид строки таблицы для сравнения с шапкой: без регистра и лишних пробелов. */
function rowKey(line: string): string {
  return splitRow(line).join('|').toLowerCase();
}

/**
 * Из ответа на строку-образец берутся ТОЛЬКО строки таблицы: живой прогон показал ответ
 * «```markdown …таблица… ``` **Обоснование:** …» — валидная таблица внутри мусора
 * вежливости, и требование «весь ответ — строки таблицы» отклоняло её целиком.
 * Продублированные моделью шапка ЭТОЙ таблицы (сравнение с фактической шапкой поля) и
 * разделитель (общий `isSeparatorRow` — модели теряют замыкающую черту) снимаются;
 * содержимое строк не редактируется. Пустой результат — поле не заполнено.
 */
export function cleanRowAnswer(answer: string, header: string): string {
  const headerKey = rowKey(header);
  return answer
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && !isSeparatorRow(l))
    .filter((l) => rowKey(l) !== headerKey)
    .join('\n');
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
    let callsSpent = 0;
    const notes: string[] = [];
    /**
     * Артефакты, запись которых ОТКЛОНИЛ гейт (политика или оператор): отказ окончательный,
     * второй проход их не трогает — иначе рантайм слал бы повторный Write после явного
     * «нет». Сбой ИСПОЛНЕНИЯ записи (fs) сюда не входит: он не решение человека, и второй
     * проход вправе попробовать снова.
     */
    const writeDenied = new Set<string>();
    /**
     * Тексты, собранные моделью, но не доехавшие до диска из-за СБОЯ ИСПОЛНЕНИЯ записи
     * (не отказа гейта): повторяется ЗАПИСЬ этого текста, а не работа модели — без этого
     * второй проход заново оплачивал все поля бланка и удваивал счётчик (ревью-3).
     */
    const pendingText = new Map<string, string>();
    /** Хоть одна запись состоялась — для честного хвоста сводки «записано через гейт». */
    let wroteAny = false;
    /** Ноты, которые не должны дублироваться вторым проходом. */
    const notedOnce = new Set<string>();

    /**
     * Незаполненные поля, оставшиеся НА ДИСКЕ, — один источник и для условия второго
     * прохода, и для честной сводки: счётчик по ходу прохода пропускал поля отклонённых
     * бланков и врал «осталось 0» (ревью-2). `retriableOnly` — для условия второго
     * прохода: бланки с отказом гейта пересчитывать незачем, проход по ним холостой.
     */
    const fieldsLeftOnDisk = (retriableOnly = false): number =>
      artifacts.reduce((n, p) => {
        if (retriableOnly && writeDenied.has(p)) return n;
        const a = readArtifact(p);
        return n + (a.exists ? groupFields(a.text).length : 0);
      }, 0);

    /**
     * Запись собранного текста через гейт — тем же путём, что любая запись исполнителя:
     * нормализованный Write, политика решает, оператор одобряет. Отказ гейта окончателен
     * (`writeDenied`); неудача исполнения — текст сохраняется в `pendingText` для
     * повторной записи. `true` — на диске.
     */
    const flushArtifact = async (path: string, text: string): Promise<boolean> => {
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
        writeDenied.add(path);
        pendingText.delete(path);
        return false;
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
      if (!outcome.ok) {
        notes.push(`запись ${rel} не удалась: ${outcome.text}`);
        pendingText.set(path, text);
        return false;
      }
      wroteAny = true;
      pendingText.delete(path);
      return true;
    };

    /** Полевой до-запрос модели: промпт этапа + служебная обвязка поля (см. шапку файла). */
    const askField = (path: string, text: string, range: FormField): ReturnType<ChatProvider['chat']> =>
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
                  'без скобок ‹› и без пояснений вокруг. Соблюдай правила легенды секции и ' +
                  'текста этапа — обязательные теги (например `[edge]`) и формат id. ' +
                  'Если по задаче элемент ровно один — верни одну строку.' +
                  // Напоминание о минимуме повторено в инструкции поля, потому что легенду
                  // секции модели читают мимо (три модели тремя способами провалили ровно
                  // это поле). ЧИСЛА минимума здесь не называются намеренно: они — правило
                  // методологии, живут в тексте этапа (он в системном промпте выше), и
                  // копия чисел в коде разошлась бы с ним при первой правке (правило из
                  // build.ts, подтверждённое ревью).
                  (/claim-/.test(range.text)
                    ? ' Это ПРИЁМОЧНЫЙ ЛИСТ: правила этапа задают минимум числа пунктов и ' +
                      'обязательных [edge]-пометок — лист короче минимума роняет этап; ' +
                      'id строго в форме `claim-1`, `claim-2`, …'
                    : '')
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
      });

    /**
     * Проход по бланкам. `StageResult` — обрыв всего этапа (бюджет, отмена), `null` —
     * проход закончен штатно. Вынесен в функцию ради ВТОРОГО прохода: поле, не взятое
     * одним сэмплом (пустой ответ, ответ с плейсхолдером), со второго захода часто
     * берётся — дисперсия дешёвых моделей работает и в эту сторону, а незакрытое поле
     * стоит целой красной попытки этапа.
     */
    const sweep = async (): Promise<StageResult | null> => {
      for (const path of artifacts) {
        // Отмена возвращается без записи собранного: запись идёт через гейт одобрения, а
        // оператор, нажавший отмену, уходит — ждать его решения на прощальном Write нельзя.
        // Оплаченные ответы этой цены отмены не отменяют, и это названо, а не спрятано.
        if (req.signal.aborted) return { ok: false, finalText: '', usage, note: 'этап отменён' };
        if (writeDenied.has(path)) continue;

        // Текст, не доехавший до диска из-за сбоя записи, ПЕРЕЗАПИСЫВАЕТСЯ, а не
        // пересобирается моделью: поля в нём уже оплачены. Не записался снова — модель
        // не переспрашивается всё равно (запись не идёт, оплата ушла бы в никуда).
        const pending = pendingText.get(path);
        if (pending !== undefined) {
          await flushArtifact(path, pending);
          continue;
        }

        const artifact = readArtifact(path);
        if (!artifact.exists) {
          // Бланк не разложен — это дефект посева, а не модели: пропускаем с пометкой,
          // страж завершения назовёт незаписанный артефакт сам.
          const note = `бланк ${path} не найден — рантайм его не разложил`;
          if (!notedOnce.has(note)) {
            notedOnce.add(note);
            notes.push(note);
          }
          continue;
        }

        let text = artifact.text;
        // С конца к началу: сплайс не сдвигает позиции ещё не обработанных диапазонов.
        // Строка таблицы с плейсхолдерами — поле-ОБРАЗЕЦ, одно на весь будущий список
        // (пункты приёмки, вопросы): спрошенная «по одному полю» она давала список из
        // одного пункта. Заполняется целиком, ответ может быть несколькими строками.
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
          if (allowed <= 0) continue;
          const asked = batch.slice(0, allowed);
          callsSpent += asked.length;

          // `allSettled`, не `all`: отказ одного запроса пачки не должен ни ронять этап,
          // ни терять usage успевших соседей — их токены уже оплачены и обязаны попасть
          // в бюджет. Упавший запрос — просто незаполненное поле.
          const answers = await Promise.allSettled(asked.map((range) => askField(path, text, range)));

          for (const a of answers) {
            if (a.status !== 'fulfilled') continue;
            usage = addUsage(usage, a.value.usage);
            hooks.onUsage(a.value.usage);
          }

          // Сплайсы — ДО проверки бюджета: ответы пачки уже оплачены в любом случае, и
          // выбрасывать их из текста при обрыве значило бы платить за них второй раз.
          for (const [idx, range] of asked.entries()) {
            const a = answers[idx]!;
            if (a.status !== 'fulfilled') {
              const why = (a.reason as Error | undefined)?.message ?? String(a.reason);
              notes.push(
                `поле не спрошено (${relative(req.cwd, path)}, ` +
                  `${range.kind === 'row' ? 'строка таблицы' : range.text}): ${why.slice(0, 160)}`,
              );
              continue;
            }
            let filled = cleanFieldAnswer(a.value.text);
            if (range.kind === 'row') filled = cleanRowAnswer(filled, range.header);
            // Пустой ответ и ответ с плейсхолдером полем не считаются: диапазон остаётся
            // как был, и его честно назовут страж и предусловие следующего этапа.
            if (filled === '' || filled.includes('‹')) continue;
            text = text.slice(0, range.start) + filled + text.slice(range.end);
            fieldsFilled++;
            changed = true;
          }

          // Бюджет проверяется после пачки: цена известна только по факту, а пачка — это
          // и есть один «ход» режима. Собранный текст ПЕРЕД обрывом записывается через
          // гейт: оплаченные ответы не выбрасываются.
          const spent = usage.costUsd === null ? null : usage.costUsd + (req.spentUsdBefore ?? 0);
          if (req.maxBudgetUsd !== null && spent !== null && spent >= req.maxBudgetUsd) {
            if (changed) await flushArtifact(path, text);
            return {
              ok: false,
              finalText: '',
              usage,
              note:
                `бюджет прогона исчерпан: ${money(spent, currency)} из ` +
                `${money(req.maxBudgetUsd, currency)}`,
            };
          }
        }

        if (changed) await flushArtifact(path, text);
      }
      return null;
    };

    const stopped = await sweep();
    if (stopped !== null) return stopped;
    // Второй проход — только когда есть ЧТО добирать: остатки в бланках без отказа гейта
    // (эти стоят ходов модели — нужен запас лимита) либо недоехавшая запись (перезапись
    // БЕСПЛАТНА и лимитом ходов не запирается — иначе оплаченный текст, ради спасения
    // которого pendingText заведён, терялся бы ровно на исчерпанном лимите, ревью-4).
    const retriable =
      (fieldsLeftOnDisk(true) > 0 && callsSpent < req.maxTurns) || pendingText.size > 0;
    if (retriable && !req.signal.aborted) {
      const stopped2 = await sweep();
      if (stopped2 !== null) return stopped2;
    }
    const fieldsLeft = fieldsLeftOnDisk();

    // «Заполнено в тексте» — не «записано на диск»: отклонённая гейтом запись оставляет
    // бланк нетронутым, и сводка обязана это различать, а не отчитываться сделанным.
    // «Осталось» считается ПО ДИСКУ, включая бланки с отклонённой записью; «записано
    // через гейт» говорится только о состоявшейся записи.
    const summary =
      `заполнение по полям: в тексте заполнено ${fieldsFilled}, осталось на диске ${fieldsLeft}` +
      (notes.length > 0 ? `; ${notes.join('; ')}` : wroteAny ? '; записано через гейт' : '');
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
