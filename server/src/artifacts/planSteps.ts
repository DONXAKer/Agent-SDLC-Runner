/**
 * Шаги плана как исполняемые единицы этапа 5.
 *
 * Методология (`templates/plan.template.md`) задаёт шаг как строку нумерованного списка
 * без формы: у шага нет поля файла, символа, пункта приёмки и проверки, а пять секций
 * плана (шаги / files_to_touch / сигнатуры / покрытие claims / необратимые) не связаны
 * ключом. Рантайму от такого плана нечего исполнять по одному и нечем проверять после
 * шага — отсюда «один гигантский ход» этапа 5, на котором слабые модели и сгорают.
 *
 * Здесь две формы:
 *
 *  1. **Явная** — заголовок `### Шаг N — ‹глагол + символ›` со списком полей
 *     (`файл`, `символ`, `действие`, `закрывает`, `проверка`, `факты человека`). Один
 *     файл на шаг: шаг на два файла — это два шага. Это предложение к форме плана
 *     методологии; пока эталон её не требует, парсер принимает её как расширение.
 *  2. **Fallback** — план старой формы: по одному шагу на строку таблицы
 *     `files_to_touch` («Путь | Что делаем»), действие — текст строки. Пути берутся
 *     ТЕМ ЖЕ разбором, что у политики (`extractFilesToTouch`): второй парсер того же
 *     списка разошёлся бы с ней, и шаг мог бы вести в файл, куда писать нельзя.
 *
 * Разбор чистый и без I/O.
 */

import { parseTables } from '../md/table.ts';
import { extractFilesToTouch } from './planFiles.ts';

export interface PlanStep {
  /** Порядковый номер: из заголовка явной формы либо позиция строки в fallback. */
  n: number;
  title: string;
  /** Путь относительно корня проекта, как в плане. */
  file: string;
  /** План говорит, что файл предстоит создать. */
  isNew: boolean;
  symbol: string | null;
  /** Что сделать — одна фраза. */
  action: string;
  /** Пункты приёмки, которые шаг закрывает (`claim-N`, нижний регистр). */
  claims: string[];
  /** Команда проверки из обратных кавычек поля «проверка», если названа. */
  check: string | null;
  /** Что ожидается от проверки — текст после «ожидаемо:». */
  expect: string | null;
  /** Факты человека, относящиеся к шагу, — дословно из поля. */
  facts: string | null;
  /** Явная форма (`### Шаг N`) — `true`; fallback по `files_to_touch` — `false`. */
  explicit: boolean;
}

const STEP_HEADING_RE = /^#{2,4}\s*Шаг\s+(\d+)\s*(?:[—–:-]\s*)?(.*)$/i;
const HEADING_RE = /^#{1,6}\s/;
/** `- файл: …` и `- **файл:** …` — двоеточие бывает и внутри жирной метки. */
const FIELD_RE = /^\s*[-*]\s*\**([^:*]+?)\**\s*:\**\s*(.*)$/;
/**
 * Словарь пометок «этот файл будет создан» — тот же смысл, что у карты разведки.
 * Только про ФАЙЛ: голое «нов…» совпадало с «добавить новые кейсы» в описании правки, и
 * существующий файл уезжал в карту шагов как «(новый)».
 */
const NEW_MARK_RE =
  /\(\s*нов[а-яё]*\s*\)|нов[а-яё]*\s+(?:файл|модул)|создат[а-яё]*\s+(?:файл|модул|нов)|будет создан|отсутствует|не существует|пока нет/i;

function stripTicks(s: string): string {
  return s.trim().replace(/^`+|`+$/g, '').trim();
}

function claimsOf(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/claim-\d+/gi)) {
    const id = m[0].toLowerCase();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function fieldKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Разбор явной формы `### Шаг N — …`. Шаг без поля `файл` пропускается: исполнять нечего. */
export function extractExplicitSteps(planText: string): PlanStep[] {
  const lines = planText.split(/\r?\n/);
  const out: PlanStep[] = [];
  let cur: { n: number; title: string; fields: Map<string, string> } | null = null;

  const flush = (): void => {
    if (cur === null) return;
    const f = cur.fields;
    const fileRaw = f.get('файл') ?? '';
    // Путь — первый токен поля без кавычек и без хвостовых разделителей: пометка «(новый)»
    // живёт после него, а «`src/a.ts`, `src/b.ts`» (нарушение «один файл на шаг»)
    // давало путь «src/a.ts`,» и шаг в несуществующий файл.
    const file = stripTicks((fileRaw.split(/[\s,;]+/)[0] ?? '').replace(/[,;:]+$/, ''));
    if (file !== '' && !file.includes('‹')) {
      const symbolRaw = f.get('символ') ?? '';
      const symbol = stripTicks(symbolRaw.split(/\s+/)[0] ?? '');
      const checkRaw = f.get('проверка') ?? '';
      const checkCmd = /`([^`]+)`/.exec(checkRaw)?.[1]?.trim() ?? null;
      const expect = /ожидаемо\s*:\s*(.+)$/i.exec(checkRaw)?.[1]?.trim() ?? null;
      const facts = f.get('факты человека') ?? f.get('факты') ?? null;
      out.push({
        n: cur.n,
        title: cur.title,
        file,
        isNew: NEW_MARK_RE.test(fileRaw) || NEW_MARK_RE.test(symbolRaw),
        symbol: symbol === '' || symbol.includes('‹') ? null : symbol,
        action: (f.get('действие') ?? cur.title).trim(),
        claims: claimsOf(f.get('закрывает') ?? ''),
        check: checkCmd,
        expect,
        facts: facts === null || facts.trim() === '' ? null : facts.trim(),
        explicit: true,
      });
    }
    cur = null;
  };

  for (const line of lines) {
    const h = STEP_HEADING_RE.exec(line);
    if (h !== null) {
      flush();
      cur = { n: Number(h[1]), title: (h[2] ?? '').trim(), fields: new Map() };
      continue;
    }
    if (HEADING_RE.test(line)) {
      flush();
      continue;
    }
    if (cur === null) continue;
    const m = FIELD_RE.exec(line);
    if (m !== null) cur.fields.set(fieldKey(m[1]!), (m[2] ?? '').trim());
  }
  flush();
  return out;
}

/**
 * Fallback для плана старой формы: шаг на каждую строку таблицы `files_to_touch`.
 * Пути — из общего разбора; описание — остальные ячейки той же строки.
 */
export function stepsFromFilesToTouch(planText: string): PlanStep[] {
  const files = extractFilesToTouch(planText);
  if (files.length === 0) return [];

  const rows: string[][] = [];
  for (const t of parseTables(planText)) {
    if (/files_to_touch/i.test(t.section)) rows.push(...t.rows);
  }
  // Строки без таблицы (пути в кавычках в прозе) описания не имеют — берём и их.
  const rowFor = (file: string): string[] | null =>
    rows.find((r) => r.some((c) => stripTicks(c) === file)) ?? null;

  return files.map((file, idx) => {
    const row = rowFor(file);
    const rest = row === null ? [] : row.filter((c) => stripTicks(c) !== file && c.trim() !== '');
    const rowText = row === null ? '' : row.join(' | ');
    return {
      n: idx + 1,
      title: file,
      file,
      isNew: NEW_MARK_RE.test(rowText) || /^нов/i.test(rest.join(' ').trim()),
      symbol: null,
      action: rest.length === 0 ? `правка по плану: ${file}` : rest.join(' — '),
      claims: claimsOf(rowText),
      check: null,
      expect: null,
      facts: null,
      explicit: false,
    };
  });
}

/** Шаги плана: явная форма, если она есть, иначе fallback по `files_to_touch`. */
export function planSteps(planText: string): PlanStep[] {
  const explicit = extractExplicitSteps(planText);
  return explicit.length > 0 ? explicit : stepsFromFilesToTouch(planText);
}

/** Строка таблицы `files_to_touch` для fallback-шага — чтобы тест видел, что читается. */
export function describeStep(s: PlanStep): string {
  const bits = [
    `${s.n}) ${s.file}${s.isNew ? ' (новый)' : ''}`,
    s.symbol === null ? null : `символ ${s.symbol}`,
    s.action,
    s.claims.length === 0 ? null : `закрывает ${s.claims.join(', ')}`,
  ].filter((b): b is string => b !== null);
  return bits.join(' — ');
}

