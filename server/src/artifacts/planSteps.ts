/**
 * Шаги плана как исполняемые единицы этапа 5.
 *
 * Новая форма плана задаёт каждый шаг отдельной карточкой с адресом, действием,
 * связанными пунктами приёмки, проверкой и изменением контракта. Старый список
 * `files_to_touch` остаётся fallback для уже созданных планов.
 *
 * Здесь две формы:
 *
 *  1. **Явная** — заголовок `### Шаг N — ‹глагол + символ›` со списком полей
 *     (`файл`, `символ`, `действие`, `закрывает`, `проверка`, `контракт`, `зависит от`, `факты человека`). Один
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
  /** Поле проверки задано содержательно, даже если для шага нет отдельной команды. */
  checkSpecified: boolean;
  /** Краткий контракт до/после либо явное «н/п — причина». */
  contractChange: string | null;
  /** Поле контракта явно заполнено, включая отсутствие изменения. */
  contractSpecified: boolean;
  /** Номера шагов, результат которых нужен этому шагу. */
  dependsOn: number[];
  /** Поле зависимостей явно заполнено («нет» — допустимое значение). */
  dependenciesSpecified: boolean;
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
      const symbol = stripTicks(symbolRaw.split(/\s+/)[0] ?? '').replace(/[;,]+$/u, '');
      const checkRaw = f.get('проверка') ?? '';
      const checkCmd = /`([^`]+)`/.exec(checkRaw)?.[1]?.trim() ?? null;
      const expect = /ожидаемо\s*:\s*(.+)$/i.exec(checkRaw)?.[1]?.trim() ?? null;
      const checkSpecified = checkRaw.trim() !== '' && !checkRaw.includes('‹');
      const contractRaw = f.get('контракт') ?? '';
      const contractChange = contractRaw.trim() === '' || contractRaw.includes('‹') ? null : contractRaw.trim();
      const contractSpecified = contractChange !== null;
      const dependsOnRaw = f.get('зависит от') ?? f.get('после') ?? '';
      const dependsOn = [...dependsOnRaw.matchAll(/\b(?:шаг\s*)?(\d+)\b/gi)].map((m) => Number(m[1]));
      const dependenciesSpecified = dependsOnRaw.trim() !== '' && !dependsOnRaw.includes('‹');
      const facts = f.get('факты человека') ?? f.get('факты') ?? null;
      out.push({
        n: cur.n,
        title: cur.title,
        file,
        isNew: NEW_MARK_RE.test(fileRaw) || NEW_MARK_RE.test(symbolRaw),
        symbol: symbol === '' || symbol.includes('‹') || /^н\s*\/\s*п$/iu.test(symbol) ? null : symbol,
        action: (f.get('действие') ?? cur.title).trim(),
        claims: claimsOf(f.get('закрывает') ?? ''),
        check: checkCmd,
        expect,
        checkSpecified,
        contractChange,
        contractSpecified,
        dependsOn,
        dependenciesSpecified,
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
    else if (/^\s{2,}\S/u.test(line)) {
      const key = [...cur.fields.keys()].at(-1);
      if (key !== undefined) cur.fields.set(key, `${cur.fields.get(key)} ${line.trim()}`);
    }
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
      checkSpecified: false,
      contractChange: null,
      contractSpecified: false,
      dependsOn: [],
      dependenciesSpecified: false,
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

/** Проверяет структуру явных карточек; семантические ссылки проверяет вызывающий этап. */
export function explicitStepProblems(planText: string): string[] {
  const headings = [...planText.matchAll(/^#{2,4}\s*Шаг\s+(\d+)\b/gim)];
  if (headings.length === 0) return ['явные карточки шагов отсутствуют'];
  const steps = extractExplicitSteps(planText);
  const problems: string[] = [];
  if (steps.length !== headings.length) {
    problems.push('у одной или нескольких карточек нет корректного поля «файл»');
  }
  const seen = new Set<number>();
  for (const [index, step] of steps.entries()) {
    if (seen.has(step.n)) problems.push(`номер шага ${step.n} повторяется`);
    seen.add(step.n);
    if (step.n !== index + 1) problems.push(`шаги должны идти подряд с 1; ожидался шаг ${index + 1}, найден ${step.n}`);
    if (step.action === '' || step.action.includes('‹')) problems.push(`шаг ${step.n}: не заполнено поле «действие»`);
    if (step.claims.length === 0) problems.push(`шаг ${step.n}: укажи закрываемый claim-N или явно объясни, почему шаг не закрывает пункт`);
    if (!step.checkSpecified) problems.push(`шаг ${step.n}: укажи проверку результата или «н/п — причина»`);
    if (!step.contractSpecified) problems.push(`шаг ${step.n}: укажи изменение контракта или «н/п — причина»`);
    if (!step.dependenciesSpecified) problems.push(`шаг ${step.n}: укажи зависимые шаги или «нет»`);
    if (step.dependsOn.some((dependency) => dependency < 1 || dependency >= step.n)) {
      problems.push(`шаг ${step.n}: зависимость должна ссылаться на более ранний шаг`);
    }
  }
  return problems;
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
