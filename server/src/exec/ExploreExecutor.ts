/**
 * Флоу `loop`, этап 2 конвейером рантайма: рантайм ведёт разведку по карточкам, модель
 * отвечает на закрытые вопросы, отчёт пишет рантайм через гейт.
 *
 * Зачем. Замер 2026-09-11 (`freeship`): все пять «годных по oversize» локальных моделей
 * встали на `explore`; у `qwen3-8b` 25 вызовов — и ни одного `Read`/`Glob`/`Grep`: цикл
 * `Edit`↔`FinalizeArtifact` без прогресса, разрушающая перезапись отчёта, обрыв по длине на
 * бланке из пяти таблиц. Та же конструкция, что `stepFill` для этапа 5 и `reviewFill` для
 * этапа 6: порог «позвать инструмент» снимается по построению, модели остаётся суждение.
 *
 * Что делает конвейер (порядок значим — каждый шаг опирается на предыдущий текст):
 *  1. механические поля — `autofillExplorationReport` (название, цель, стек, команды, гейт);
 *  2. карта кодовой базы — ОДИН вопрос по карточкам файлов-кандидатов из индекса;
 *  3. найдено для переиспользования — один вопрос по кандидатам `путь:символ`;
 *  4. опоры осей — один вопрос на шесть осей (только при включённом гейте);
 *  5. всплывшие вопросы — один вопрос; рендер `- [ ] **[блокирующий]** …` свой, иначе
 *     этап 3 (`hasOpenQuestions`) их не увидит;
 *  6. лист, выведенный независимо, — результат `runClaimsBlind` (считает `Run` до старта)
 *     и механическая предсортировка (`explore/compare.ts`);
 *  7. запись №1 через гейт (`writeThroughGate`);
 *  8. свободные поля (конвенции, точка правки, границы, риски) — вложенный
 *     `FormFillExecutor` в режиме `compact` с `skipFields`;
 *  9. гейт «Заполненность артефактов» по факту — запись №2;
 * 10. «Что придётся тронуть» в `intent.md` — из карты, через гейт;
 * 11. страж этапа (`req.finishGuard`) — последнее слово.
 *
 * Что здесь НЕ происходит и названо честно:
 *  - `AskHuman` и `Task` в режиме нет: вопросы уходят в «Всплывшие вопросы», решение о
 *    полноте листа остаётся полем человека (humanGate этапа);
 *  - путь не из индекса и не помеченный новым в карту не попадает — модель не может
 *    «прочитать» файл, которого рантайм не показал; это цена режима, и она фиксируется в
 *    предупреждении и в «Границах разведки», которые пишет сама модель;
 *  - переспросов нет: строка не по форме — не разобрана, поле остаётся стражу
 *    (CR-Bench: дожимание слабой модели шумит, см. `reviewFill.ts`);
 *  - промпт этапа (`req.prompt`) уходит системным сообщением каждого вопроса вместе с
 *    индексом в `prompt.user` — оператор видит то, что видит модель, плюс карточки.
 *
 * ИМЕНОВАННОЕ ИСКЛЮЧЕНИЕ из правила «всё, что уйдёт в модель, собрано в buildPrompt»: как и у
 * `FormFillExecutor`/`StepExecutor`, вопросы несут свою обвязку (карточки, формат ответа) —
 * конструкция режима, меняется только правкой кода.
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import type { Usage } from '@sdlc-runner/shared';
import { addUsage, emptyUsage } from '@sdlc-runner/shared';

import { countPlaceholdersExceptDecisions, readArtifact, replaceAfterLabel } from '../artifacts/artifact.ts';
import { applyFill } from '../artifacts/applyFill.ts';
import { AXES, type AxisName } from '../artifacts/planAxes.ts';
import { cardBudgetPerFile, fileCard, packCards, symbolCard } from '../explore/cards.ts';
import { compareClaims, renderClaimsComparison, renderClaimsNa, reverseGaps, type AuthorClaim } from '../explore/compare.ts';
import { removeTableInSection, replaceListInSection, replaceTableRows, setListField, spliceFieldValue } from '../explore/fields.ts';
import { escapeCell, h2SectionRanges } from '../md/table.ts';
import type { ExploreIndex, IndexedFile } from '../explore/types.ts';
import type { BuiltView, EcosystemLine } from '../explore/view.ts';
import { AXIS_HINTS } from '../run/planAxisFill.ts';
import { AFFIRMATIVE_HEAD } from '../run/reviewFill.ts';
import type { BlindClaimsResult } from '../run/claimsBlind.ts';
import { autofillExplorationReport, type ExplorationFacts } from '../run/exploreAutofill.ts';
import { ProviderEnvError, type ChatMessage, type ChatProvider } from '../provider/ChatProvider.ts';
import { ESTIMATE_MARGIN_TOKENS, budgetParams, estimateMessageTokens } from './contextBudget.ts';
import { FormFillExecutor } from './FormFillExecutor.ts';
import { writeThroughGate } from './gateWrite.ts';
import type { ExecHooks, ExecRequest, StageExecutor, StageResult } from './StageExecutor.ts';
import type { ToolContext } from './tools/index.ts';

const TEMPLATE = 'exploration-report.template.md';
const INTENT_TEMPLATE = 'intent.template.md';

/** Поля, которые конвейер заполняет сам, — вложенному дозаполнению их не отдаём. */
const STRUCTURED_FIELDS: readonly string[] = [
  'гейт «заполненность артефактов»',
  'карта кодовой базы',
  'найдено для переиспользования',
  'найдено для переиспользования/найдено для переиспользования',
  'опоры осей',
  'расхождение',
  'всплывшие вопросы',
];

export interface ExploreExecutorOptions {
  provider: ChatProvider;
  params?: Record<string, unknown> | null;
  currency?: string;
  contextWindow?: number;
  maxResultBytes: number;
  readRangeRequiredAboveBytes: number;
  bashTimeoutMs: number;
  index: ExploreIndex;
  built: BuiltView;
  ecosystem: readonly EcosystemLine[];
  intent: {
    path: string;
    readinessPath: string;
    title: string;
    brief: string | null;
    claims: readonly AuthorClaim[];
    notDoing: readonly string[];
  };
  reportPath: string;
  /** `null` — слепой вывод не запускался; причина — в `claimsSkipReason`. */
  claims: BlindClaimsResult | null;
  claimsSkipReason: string | null;
  axesEnabled: boolean;
  fillednessGate: ExplorationFacts['fillednessGate'];
  edgeExample: readonly string[];
  /** Потолок карточек одного вопроса — окно локальной модели, не вкус. */
  cardBudgetBytes: number;
}

interface Parsed {
  n: number;
  parts: string[];
}

/** `N. a | b | c` → номер и части; строки не по форме пропускаются, дубли номеров тоже. */
export function parseNumberedAnswer(text: string): Parsed[] {
  const out: Parsed[] = [];
  const seen = new Set<number>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)[.)]\s*(.*)$/.exec(raw);
    if (m === null) continue;
    const n = Number(m[1]);
    if (seen.has(n)) continue;
    const rest = (m[2] ?? '').trim();
    if (rest === '') continue;
    seen.add(n);
    out.push({ n, parts: rest.split('|').map((p) => p.trim()) });
  }
  return out;
}

// Модель, ответившая прозой вместо формы («+ добавим обработку скидки», без пути вовсе),
// без этой проверки давала бы строку карты «файла нет — новый» с прозой вместо пути в
// колонке «Файл» — формально проходит стража `declaredAsNew`, но карта врёт о том, что
// вообще является путём (ревью code-review-all, 2026-09-11). Путь — без пробелов и либо
// со слэшем, либо с расширением: тот же минимум, что у `PATH_RE` в `explore/keywords.ts`.
const PLUS_PATH_RE = /^[\w./@-]+$/;
function looksLikePath(p: string): boolean {
  return PLUS_PATH_RE.test(p) && (p.includes('/') || /\.[a-z0-9]{1,8}$/i.test(p));
}

/** Строки `+ путь | что создаём` — будущие файлы. */
export function parsePlusLines(text: string): { path: string; what: string }[] {
  const out: { path: string; what: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*\+\s*(.+)$/.exec(raw);
    if (m === null) continue;
    const parts = (m[1] ?? '').split('|').map((p) => p.trim());
    const path = (parts[0] ?? '').replace(/^`|`$/g, '').trim();
    if (path === '' || !looksLikePath(path)) continue;
    out.push({ path, what: parts.slice(1).join(' | ').trim() });
  }
  return out;
}

// Локальная модель отвечает на закрытый вопрос и по-английски (`yes`/`no`) чаще, чем можно
// ожидать от русскоязычного бланка — тот же класс, из-за которого `reviewFill.ts` завёл
// `AFFIRMATIVE_HEAD` вместо голого «да». Симметричный отрицательный вариант здесь свой:
// у `reviewFill.ts` отрицания как отдельного значения нет (только да/пропуск).
const YES = AFFIRMATIVE_HEAD;
const NO = /^(?:нет(?=\s|[—:,.!]|$)|no\b)/i;
const NO_MECHANISM = /^нет\s+механизма/i;

/** Значение колонки в проводном формате `sheet.ts` (форма 1): переносы и `|` сняты. */
function cell(v: string): string {
  return v.replace(/\s*\r?\n\s*/g, ' ').replace(/\|/g, '/').trim();
}

/**
 * Плейсхолдеры готовности задачи — БЕЗ «Прогон 2»: та секция бланка заполняется этапом 4
 * (план), не разведкой, и на этапе 2 честно стоит плейсхолдерами. Без вычета гейт
 * «Заполненность артефактов» не мог дойти до ✅ вообще ни на одной задаче — «незаполненных
 * мест» было бы больше нуля из-за секции, которую в этом этапе и не должны трогать (ревью
 * code-review-all, 2026-09-11).
 */
function readinessPlaceholdersForExplore(text: string): number {
  const run2 = h2SectionRanges(text, /^прогон\s*2\b/i)[0];
  if (run2 === undefined) return countPlaceholdersExceptDecisions(text);
  return countPlaceholdersExceptDecisions(text.slice(0, run2.start) + text.slice(run2.end));
}

export class ExploreExecutor implements StageExecutor {
  readonly flow = 'loop' as const;
  private readonly o: ExploreExecutorOptions;

  constructor(o: ExploreExecutorOptions) {
    this.o = o;
  }

  private paramsFor(messages: readonly ChatMessage[], hooks: ExecHooks): Record<string, unknown> | null {
    if (this.o.contextWindow === undefined) return this.o.params ?? null;
    const window = this.o.contextWindow;
    return budgetParams({
      contextWindow: window,
      params: this.o.params,
      promptTokens: estimateMessageTokens(messages),
      // Вопросы разведки идут без инструментов — запас только на неточность оценки, как у
      // полевых запросов (`ESTIMATE_MARGIN_TOKENS`), а не в целый результат инструмента.
      marginTokens: ESTIMATE_MARGIN_TOKENS,
      onClamped: (maxTokens) =>
        hooks.onWarn(
          `окно контекста (${window}) почти исчерпано этим вопросом разведки — max_tokens ` +
            `ограничен полом ${maxTokens}, переполнение всё ещё вероятно`,
        ),
    });
  }

  private fileByPath(path: string): IndexedFile | undefined {
    const norm = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^`|`$/g, '');
    return this.o.index.files.find((f) => f.path === norm || f.path.toLowerCase() === norm.toLowerCase());
  }

  async run(req: ExecRequest, hooks: ExecHooks): Promise<StageResult> {
    const toolCtx: ToolContext = {
      projectRoot: req.cwd,
      maxResultBytes: this.o.maxResultBytes,
      readRangeRequiredAboveBytes: this.o.readRangeRequiredAboveBytes,
      timeoutMs: this.o.bashTimeoutMs,
      signal: req.signal,
    };
    let usage: Usage = emptyUsage();
    let calls = 0;
    /** Обращения к модели вложенного дозаполнения свободных полей — своим счётчиком у него. */
    let nestedRequests = 0;
    const notes: string[] = [];
    let envFailure: string | null = null;
    const rel = (p: string): string => relative(req.cwd, p).replace(/\\/g, '/');

    const fail = (note: string): StageResult => ({
      ok: false,
      finalText: notes.join('\n'),
      usage,
      note,
      modelRequests: calls + nestedRequests,
      ...(envFailure === null ? {} : { envFailure }),
    });

    /** Один вопрос модели: промпт этапа + обвязка. `null` — запрос не состоялся (среда, бюджет ходов). */
    const ask = async (title: string, body: string): Promise<string | null> => {
      if (req.signal.aborted) return null;
      if (calls >= req.maxTurns) {
        notes.push(`${title}: лимит ходов этапа (${req.maxTurns}) исчерпан — вопрос не задан`);
        return null;
      }
      calls++;
      const messages: ChatMessage[] = [
        { role: 'system', content: req.prompt.system },
        { role: 'user', content: `${req.prompt.user}\n\n## Сейчас — ${title}\n\n${body}` },
      ];
      try {
        const answer = await this.o.provider.chat({
          model: req.model,
          messages,
          tools: [],
          signal: req.signal,
          temperature: null,
          params: this.paramsFor(messages, hooks),
        });
        usage = addUsage(usage, answer.usage);
        hooks.onUsage(answer.usage);
        hooks.onExchange?.({ question: `## ${title}\n\n${body}`, answer: answer.text });
        if (answer.finishReason === 'max_tokens') {
          hooks.onFriction('truncated');
          notes.push(`${title}: ответ обрезан лимитом длины — разобрано то, что дошло`);
        }
        return answer.text;
      } catch (e) {
        if (envFailure === null && e instanceof ProviderEnvError) envFailure = e.message;
        notes.push(`${title}: запрос не удался — ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
        return null;
      }
    };

    const report = readArtifact(this.o.reportPath);
    if (!report.exists) return fail(`бланк отчёта разведки не разложен: ${this.o.reportPath}`);

    // 1. Механика.
    const auto = autofillExplorationReport(report.text, {
      title: this.o.intent.title,
      brief: this.o.intent.brief,
      stack: this.o.ecosystem,
      fillednessGate: this.o.fillednessGate,
    });
    let text = auto.text;
    notes.push(`механических полей заполнено: ${auto.filled}`);

    const claimsBlock =
      this.o.intent.claims.length === 0
        ? '(приёмочный лист задачи пуст)'
        : this.o.intent.claims.map((c) => `- ${c.id}: ${c.text}`).join('\n');

    // 2. Карта кодовой базы.
    const ranked = this.o.built.ranked;
    const perCard = cardBudgetPerFile(this.o.cardBudgetBytes, ranked.length);
    const mapRows: Record<string, string>[] = [];
    if (ranked.length === 0) {
      notes.push('карта: индекс не дал ни одного кандидата — карту составить не по чему');
    } else {
      const answer = await ask(
        'карта кодовой базы',
        [
          'Пункты приёмки задачи:',
          claimsBlock,
          '',
          'Файлы-кандидаты (пронумерованы; ниже — их содержимое, обрезанное по потолку):',
          ...ranked.map((r, i) => `${i + 1}. \`${r.file.path}\` — ${r.why.join('; ')}`),
          '',
          packCards(
            ranked.map((r) => fileCard(r.file, perCard)),
            this.o.cardBudgetBytes,
          ),
          '',
          'Ответь по одной строке на КАЖДЫЙ номер, строго в форме:',
          '`N. да | что там сейчас (классы/функции, одной фразой) | что меняем` — файл относится к задаче;',
          '`N. нет` — не относится.',
          'Файл, которого ещё нет и который предстоит создать: `+ путь/от/корня | что создаём`.',
          'Только эти строки, без заголовков и пояснений. Файлы вне этого списка называть нельзя — их ты не читала.',
        ].join('\n'),
      );
      if (answer !== null) {
        for (const p of parseNumberedAnswer(answer)) {
          const r = ranked[p.n - 1];
          if (r === undefined) continue;
          const head = p.parts[0] ?? '';
          if (NO.test(head)) continue;
          if (!YES.test(head)) continue;
          const now = p.parts[1] ?? '';
          // Последнее поле строки, а не третье строго: модель, добавившая в «что меняем»
          // собственный `|` (перечисление, уточнение), иначе теряла бы всё после второго
          // разделителя молча — тот же приём, что уже применяют вопросы и опоры осей ниже
          // (`p.parts.slice(1).join(' | ')`) (ревью code-review-all, 2026-09-11).
          const change = p.parts.slice(2).join(' | ').trim();
          if (now === '' && change === '') continue;
          mapRows.push({ файл: r.file.path, 'что там сейчас': now || '—', 'что меняем': change || '—' });
        }
        for (const plus of parsePlusLines(answer)) {
          const existing = this.fileByPath(plus.path);
          if (existing !== undefined) {
            if (!mapRows.some((row) => row['файл'] === existing.path)) {
              mapRows.push({ файл: existing.path, 'что там сейчас': 'см. файл (назван как новый, но существует)', 'что меняем': plus.what || '—' });
            }
            continue;
          }
          // Будущий файл: «файла нет — новый» проходит `declaredAsNew` стража карты.
          mapRows.push({ файл: plus.path, 'что там сейчас': 'файла нет — новый', 'что меняем': plus.what || '—' });
        }
        if (mapRows.length === 0) notes.push('карта: ответ модели не дал ни одной строки — поле остаётся стражу');
      }
    }
    if (mapRows.length > 0) {
      // Своими строками, не `applyFill`: после первого прохода строки таблицы несут
      // реальные пути, а не образец с `‹…›` — `deriveSchema` перестаёт видеть их как
      // строки-образец, и поле «карта кодовой базы» пропадает из схемы целиком. Повторный
      // ход этапа (страж потребовал доделать что-то ещё) тогда тихо не мог переписать УЖЕ
      // заполненную карту (ревью code-review-all, 2026-09-11) — тот же класс, из-за
      // которого «опоры осей» уже написаны через `replaceTableRows`.
      text = replaceTableRows(
        text,
        /^карта кодовой базы$/i,
        mapRows.map((r) => `| ${escapeCell(r['файл'] ?? '')} | ${escapeCell(r['что там сейчас'] ?? '')} | ${escapeCell(r['что меняем'] ?? '')} |`),
      );
    }

    // 3. Найдено для переиспользования.
    const reuse = this.o.built.reuse;
    const reuseRows: Record<string, string>[] = [];
    // «Ответили «нет» на все кандидаты» и «вопрос не задан» (лимит ходов, отмена,
    // отказ среды) обе дают пустой `reuseRows` — не различая их, конвейер писал бы
    // «ничего подходящего не найдено» и в случае, когда поиск попросту не проводился
    // (ревью code-review-all, 2026-09-11): проверенное утверждение неотличимо от
    // непроверенного.
    let reuseAsked = false;
    if (reuse.length > 0) {
      const cards: string[] = [];
      for (const c of reuse.slice(0, 6)) {
        const f = this.fileByPath(c.path);
        const s = f?.symbols.find((x) => x.name === c.symbol);
        if (f !== undefined && s !== undefined) cards.push(symbolCard(f, s, 15));
      }
      const answer = await ask(
        'найдено для переиспользования',
        [
          'Пункты приёмки задачи:',
          claimsBlock,
          '',
          'Кандидаты (уже существующие символы; пронумерованы):',
          ...reuse.map((c, i) => `${i + 1}. \`${c.path}:${c.symbol}\` — \`${c.signature}\` — вызывающих: ${c.callers}`),
          '',
          packCards(cards, Math.floor(this.o.cardBudgetBytes / 2)),
          '',
          'Что из этого мы ВЫЗЫВАЕМ в этой задаче вместо того, чтобы писать заново? По строке на номер:',
          '`N. да | что делает | как используем` либо `N. нет`. Только эти строки.',
        ].join('\n'),
      );
      if (answer !== null) {
        const parsed = parseNumberedAnswer(answer);
        // Ответ пришёл, но НИ ОДНОЙ строки в форме «N. …» — модель ответила прозой мимо
        // формата (замер `oversize`/`exploreFill`, 2026-09-12: обе проверенные модели,
        // `qwen3-8b` и `gemma-4-e4b`, дали «переиспользования 0» при 12 предложенных
        // кандидатах). Без этой проверки несостоявшийся разбор ответа неотличим от
        // честного «нет» на все кандидаты — тот же класс, от которого уже защищает
        // ветка «вопрос не задан» комментарием выше, только на шаг ближе к модели.
        reuseAsked = parsed.length > 0;
        for (const p of parsed) {
          const c = reuse[p.n - 1];
          if (c === undefined || !YES.test(p.parts[0] ?? '')) continue;
          reuseRows.push({
            символ: c.symbol,
            где: `${c.path}:${c.symbol}`,
            'что делает': p.parts[1] || c.signature,
            // Последнее поле — та же терпимость к лишнему `|`, что у карты кодовой базы.
            'как используем': p.parts.slice(2).join(' | ').trim() || '—',
          });
        }
      }
    }
    // Строка-меню «Ничего подходящего не найдено: да / нет» — прямой разбор текста, не
    // схема: `deriveSchema` даёт полю разные id смотря по тому, заполнена ли соседняя
    // таблица (комментарий ниже был про это), но на ВТОРОМ проходе по уже заполненному
    // отчёту та же схема вообще перестаёт видеть строку как `choice` — значение там уже
    // не плейсхолдер `‹да / нет›`, а голое «да»/«нет» прошлого прохода, и поле пропадало
    // бы из схемы целиком, как таблицы карты/переиспользования (см. комментарий у карты
    // кодовой базы; ревью code-review-all, 2026-09-11). Фраза в шаблоне ровно одна.
    const REUSE_CHOICE_RE = /(Ничего подходящего не найдено:\s*)([^_\n]*)/i;
    const reuseChoice = (t: string, value: 'да' | 'нет'): string => {
      if (!REUSE_CHOICE_RE.test(t)) {
        notes.push('строка «ничего подходящего не найдено» в бланке не найдена');
        return t;
      }
      return t.replace(REUSE_CHOICE_RE, (_m, pre: string) => `${pre}${value}`);
    };
    if (reuseRows.length > 0) {
      // Своими строками — та же причина, что у карты кодовой базы (см. комментарий там):
      // повторный проход по уже заполненной таблице иначе не находил бы поле в схеме.
      text = replaceTableRows(
        text,
        /^найдено для переиспользования$/i,
        reuseRows.map(
          (r) =>
            `| ${escapeCell(r['символ'] ?? '')} | ${escapeCell(r['где'] ?? '')} | ${escapeCell(r['что делает'] ?? '')} | ${escapeCell(r['как используем'] ?? '')} |`,
        ),
      );
      text = reuseChoice(text, 'нет');
    } else if (reuse.length === 0 || reuseAsked) {
      // Форма: пустую таблицу удалить целиком и поставить явное «да» — утверждение о
      // проведённом поиске (кандидатов не было ВООБЩЕ, либо на все был честный «нет»), а
      // не о том, что искать забыли.
      text = reuseChoice(removeTableInSection(text, /^найдено для переиспользования$/i, ''), 'да');
    } else {
      // Кандидаты были, но проверка не состоялась — либо вопрос не задан (лимит ходов,
      // отмена, отказ среды), либо ответ пришёл мимо формата (ни одной строки «N. …») —
      // поле остаётся плейсхолдером стражу в обоих случаях, а не тихим «ничего не нашли».
      notes.push('переиспользование: вопрос не задан или ответ не по форме — поле остаётся стражу');
    }

    // 4. Опоры осей.
    if (this.o.axesEnabled) {
      const axes = this.o.built.view.axes;
      const rows: Record<string, string>[] = [];
      const answer = await ask(
        'опоры осей',
        [
          'Оси прод-готовности (пронумерованы) и кандидаты механизмов, которые рантайм нашёл по признакам:',
          ...AXES.map((axis, i) => {
            const hits = axes?.[axis] ?? [];
            const hint = AXIS_HINTS[axis as AxisName] ?? '';
            return `${i + 1}. ${axis} — ${hint}\n   кандидаты: ${hits.length === 0 ? '(не видно)' : hits.map((h) => `\`${h.path}:${h.symbol ?? `строка ${h.line}`}\``).join(', ')}`;
          }),
          '',
          'Для КАЖДОЙ оси одной строкой: `N. путь:символ | как этот механизм применяется в задаче` либо',
          '`N. нет механизма | почему не применим`. Адрес — только из кандидатов или из индекса проекта; ' +
            'сочинять адрес нельзя, «нет механизма» — законный ответ.',
        ].join('\n'),
      );
      if (answer !== null) {
        for (const p of parseNumberedAnswer(answer)) {
          const axis = AXES[p.n - 1];
          if (axis === undefined) continue;
          const head = (p.parts[0] ?? '').replace(/^`|`$/g, '');
          const how = p.parts.slice(1).join(' | ').trim();
          if (NO_MECHANISM.test(head) || NO.test(head)) {
            rows.push({ ось: axis, 'механизм проекта': 'нет механизма', 'как он применяется здесь': how || 'не применим' });
            continue;
          }
          const [path = '', symbol = ''] = head.split(':');
          const f = this.fileByPath(path);
          if (f === undefined) {
            hooks.onWarn(`опоры осей: адрес «${head}» не из индекса — ось «${axis}» оставлена без механизма`);
            rows.push({ ось: axis, 'механизм проекта': 'нет механизма', 'как он применяется здесь': how || 'адрес не подтверждён' });
            continue;
          }
          const known = symbol !== '' && f.symbols.some((s) => s.name === symbol);
          rows.push({ ось: axis, 'механизм проекта': known ? `${f.path}:${symbol}` : f.path, 'как он применяется здесь': how || '—' });
        }
      }
      // Своими строками, не `applyFill`: колонка «Механизм проекта» в схеме — меню
      // («‹path:Symbol› / нет механизма»), и адрес вне меню рендерился бы как «н/п».
      if (rows.length > 0) {
        text = replaceTableRows(
          text,
          /^опоры осей$/i,
          rows.map((r) => `| ${r['ось']} | ${escapeCell(r['механизм проекта'] ?? '')} | ${escapeCell(r['как он применяется здесь'] ?? '')} |`),
        );
      }
    } else {
      text = removeTableInSection(text, /^опоры осей$/i, 'н/п — гейт «Разбор последствий» в долге');
    }

    // 5. Всплывшие вопросы.
    {
      const answer = await ask(
        'всплывшие вопросы',
        [
          'Что требует решения человека до chunk\'а и чего нет ни в задаче, ни в коде? Только вопросы, ' +
            'ответ на которые нельзя добыть из кодовой базы. По строке: `N. блокирующий | вопрос` или ' +
            '`N. неблокирующий | вопрос`. Если вопросов нет — одна строка `нет вопросов`.',
        ].join('\n'),
      );
      if (answer !== null) {
        const items: string[] = [];
        for (const p of parseNumberedAnswer(answer)) {
          const head = p.parts[0] ?? '';
          // Сентинел «вопросов нет» — не вопрос, даже если модель вопреки инструкции дала
          // ему номер («1. нет вопросов»): без этой отсечки строка ниже попала бы в список
          // как настоящий пункт.
          if (p.parts.length === 1 && /^нет\s+вопросов\s*$/i.test(head)) continue;
          const kind = /^блок/i.test(head) ? 'блокирующий' : 'неблокирующий';
          // Без «|» текст вопроса — весь `parts[0]` за вычетом ведущей метки кем/чем он
          // назван («блокирующий»/«неблокирующий» + необязательный разделитель). Раньше
          // запасной путь работал ТОЛЬКО для «неблокирующий»: блокирующий вопрос без «|»
          // (`1. блокирующий: применяется ли льгота к silver?`) молча терялся — ровно тот
          // класс вопросов, которые этот механизм обязан не терять (ревью code-review-all,
          // 2026-09-11).
          const stripped = head.replace(/^(?:не)?блок[а-яё]*\s*[:\-—]?\s*/i, '').trim();
          const q = p.parts.slice(1).join(' | ').trim() || stripped;
          if (q === '') continue;
          items.push(`[ ] **[${kind}]** ${cell(q)}`);
        }
        // Свой рендер, а не `applyFill`: у поля отдельная строка-альтернатива «нет вопросов»,
        // и элементы обязаны сохранить `- [ ]` — иначе этап 3 (`hasOpenQuestions`) их не увидит.
        // Плейсхолдер — `setListField`; повторный проход по уже заполненному списку (строки
        // реальные, без образца с `‹…›`) видит `deriveSchema`, переставшую находить поле, —
        // `replaceListInSection` бьёт по секции текстом, не схемой (тот же класс, что у
        // карты/переиспользования и «Расхождения»; ревью code-review-all, 2026-09-11).
        text = setListField(text, TEMPLATE, 'всплывшие вопросы', items) ?? replaceListInSection(text, /^всплывшие вопросы$/i, items, 'нет вопросов');
      }
    }

    // 6. Лист, выведенный независимо.
    if (this.o.claims !== null && this.o.claims.claims.length > 0) {
      const compared = compareClaims(this.o.claims.claims, this.o.intent.claims, this.o.intent.notDoing);
      const gaps = reverseGaps(this.o.intent.claims, this.o.claims.claims);
      text = renderClaimsComparison(text, compared, gaps);
      notes.push(
        `сверка листов: совпало ${compared.filter((c) => c.verdict.kind === 'author').length}, ` +
          `кандидатов в пропуск ${compared.filter((c) => c.verdict.kind === 'candidate').length}, ` +
          `вне scope ${compared.filter((c) => c.verdict.kind === 'outOfScope').length}, у автора без пары ${gaps.length}`,
      );
    } else {
      const reason =
        this.o.claimsSkipReason ??
        (this.o.claims === null ? 'второго измерения не было' : 'субагент вернул пустой лист — второго измерения не было');
      text = renderClaimsNa(text, reason);
      notes.push(`сверка листов: н/п — ${reason}`);
    }

    if (req.signal.aborted) return fail('этап отменён');

    // 7. Запись №1.
    const first = await writeThroughGate(hooks, req, toolCtx, this.o.reportPath, text, 'explore');
    if (!first.ok) return fail(`запись отчёта разведки ${first.denied ? 'отклонена гейтом' : 'не удалась'}: ${first.reason}`);

    // 8. Свободные поля — вложенным дозаполнением по карточкам.
    const nested = await new FormFillExecutor({
      provider: this.o.provider,
      maxResultBytes: this.o.maxResultBytes,
      readRangeRequiredAboveBytes: this.o.readRangeRequiredAboveBytes,
      bashTimeoutMs: this.o.bashTimeoutMs,
      params: this.o.params ?? null,
      // Без окна дозаполнение свободных полей разведки шло без расчёта `max_tokens` по
      // остатку — ровно там, где промпт этапа крупнее всего.
      ...(this.o.contextWindow === undefined ? {} : { contextWindow: this.o.contextWindow }),
      ...(this.o.currency === undefined ? {} : { currency: this.o.currency }),
      compact: true,
      stage: 'explore',
      edgeExample: this.o.edgeExample,
      skipFields: STRUCTURED_FIELDS,
    }).run(
      {
        ...req,
        formArtifacts: [this.o.reportPath],
        finishGuard: null,
        salvageFromText: null,
        maxTurns: Math.max(0, req.maxTurns - calls),
      },
      hooks,
    );
    usage = addUsage(usage, nested.usage);
    nestedRequests = nested.modelRequests ?? 0;
    notes.push(`свободные поля: ${nested.note}`);
    if (nested.envFailure !== undefined && envFailure === null) envFailure = nested.envFailure;
    // `nested.ok` игнорировался: отмена и исчерпание бюджета ходов внутри вложенного
    // добора («вложенный `finishGuard: null» лишает его собственного стража) не доходили
    // выше — этап 9–10 всё равно писали в отчёт и страж этапа мог не заметить пропажу
    // (файл уже не «нетронутый»), и явно неоконченный ход возвращался бы `ok: true`
    // (ревью code-review-all, 2026-09-11). Шаги 9–10 ниже бесплатны (без хода модели) и
    // всё равно выполняются — иначе уже посчитанная карта осталась бы без «Что придётся
    // тронуть»; итог всего этапа при этом остаётся `ok: false`.
    const nestedFailed = !nested.ok;

    // 9. «Что придётся тронуть» в задаче — из карты. ДО гейта заполненности: он считает
    // плейсхолдеры и в задаче тоже, и незаполненный образец этой секции красил бы его ❌.
    if (mapRows.length > 0) {
      let intentText: string;
      try {
        intentText = readFileSync(this.o.intent.path, 'utf8');
      } catch {
        intentText = '';
      }
      if (intentText !== '') {
        const rows = mapRows.map((r) => `- ${r['файл']} — ${cell(r['что меняем'] ?? '—').replace(/\s+[—–]\s+/g, ' - ')}`).join('\n');
        const applied = applyFill(intentText, 'что придется тронуть', rows, 'set', INTENT_TEMPLATE);
        if (applied.ok) {
          if (applied.text !== intentText) {
            const w = await writeThroughGate(hooks, req, toolCtx, this.o.intent.path, applied.text, 'explore');
            if (!w.ok) notes.push(`«Что придётся тронуть» в ${rel(this.o.intent.path)} не записано: ${w.reason}`);
          }
        } else notes.push(`«Что придётся тронуть» не записано: ${applied.problem}`);
      }
    }

    // 10. Гейт «Заполненность артефактов» — по факту, после всех заполнений. Не `applyFill`:
    // меню поля несёт пояснение в самом варианте («✅/❌ — греп …»), и рендер меню вставлял
    // бы наш счёт внутрь этого текста; здесь заменяется вся ветка после метки.
    if (this.o.fillednessGate === 'enabled') {
      const fresh = readArtifact(this.o.reportPath);
      // Счёт — по отчёту с уже подставленным статусом: собственный плейсхолдер строки гейта
      // иначе считался бы «незаполненным местом» и красил гейт ❌ на полном отчёте.
      const tentative = spliceFieldValue(fresh.text, TEMPLATE, 'гейт «заполненность артефактов»', '✅') ?? fresh.text;
      const left =
        countPlaceholdersExceptDecisions(tentative) +
        countPlaceholdersExceptDecisions(readArtifact(this.o.intent.path).text) +
        readinessPlaceholdersForExplore(readArtifact(this.o.intent.readinessPath).text);
      const gateValue = left === 0 ? '✅' : `❌ — незаполненных мест: ${left}`;
      // Плейсхолдер («‹✅/❌ — …› / ⏭ — гейт в долге») даёт `spliceFieldValue`. Повторный
      // проход по УЖЕ проставленному статусу (например, второй ход этапа после того, как
      // страж потребовал доделать другое поле) видит вместо него голое «✅»/«❌ …» — не
      // плейсхолдер, и схема поле больше не находит; `replaceAfterLabel` бьёт по самой
      // метке «- **Гейт «Заполненность артефактов»:**» текстом, не схемой, и обновляет
      // строку в этом случае (тот же класс, что у карты/переиспользования выше; ревью
      // code-review-all, 2026-09-11).
      const spliced =
        spliceFieldValue(fresh.text, TEMPLATE, 'гейт «заполненность артефактов»', gateValue) ??
        replaceAfterLabel(fresh.text, 'Гейт «Заполненность артефактов»', gateValue);
      if (spliced !== null && spliced !== fresh.text) {
        const second = await writeThroughGate(hooks, req, toolCtx, this.o.reportPath, spliced, 'explore');
        if (!second.ok) notes.push(`гейт заполненности не записан: ${second.reason}`);
      } else if (spliced === null) notes.push('гейт заполненности не записан: поля нет в бланке');
    }

    // 11. Страж этапа — последнее слово.
    const complaint = req.finishGuard?.() ?? null;
    const summary = [
      `разведка конвейером: запросов ${calls} (+ дозаполнение), строк карты ${mapRows.length}, переиспользования ${reuseRows.length}`,
      ...notes,
    ].join('\n');
    hooks.onText(summary);
    const tail = { modelRequests: calls + nestedRequests, ...(envFailure === null ? {} : { envFailure }) };
    if (complaint !== null) return { ok: false, finalText: summary, usage, note: complaint, ...tail };
    if (nestedFailed) return { ok: false, finalText: summary, usage, note: `дозаполнение свободных полей не завершено: ${nested.note}`, ...tail };
    return { ok: true, finalText: summary, usage, note: 'разведка проведена конвейером рантайма', ...tail };
  }
}
