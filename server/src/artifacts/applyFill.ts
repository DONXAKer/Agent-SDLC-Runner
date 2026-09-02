/**
 * Значение поля → markdown артефакта. Обратная сторона `sheet.ts`: модель называет
 * значение словом, разметку — экранирование `|`, нумерацию `claim-N`, стирание лишней
 * ветки меню — рисует рантайм.
 *
 * Идемпотентно и без I/O: схема пересчитывается от ТЕКУЩЕГО текста на каждый вызов —
 * поле не «используется один раз», а остаётся в схеме и после заполнения (диапазоны
 * считаются от метки/шапки, а не от плейсхолдера), так что повторный `set` того же поля
 * заменяет значение, а не дублирует его.
 */

import { escapeCell, isSeparatorRow } from '../md/table.ts';
import { deriveSchema, findField, type FormField } from './formSchema.ts';
import { isSheetError, matchChoice, parseFieldValue, type SheetValue } from './sheet.ts';

export interface ApplyOk {
  ok: true;
  text: string;
  /** Что записалось — для сводки, тем же духом, что «применено» у обычного `Edit`. */
  rendered: string;
  /**
   * Записи `records` меньше минимума листа (`field.min`) — вызывающий решает, добирать
   * ли ОДНИМ повторным запросом (тот же приём, что у legacy-доборa приёмочного листа),
   * а не сам факт: `applyFill` не задаёт второй вопрос модели, он остаётся снаружи.
   */
  short?: boolean;
}

export interface ApplyProblem {
  ok: false;
  problem: string;
}

/** Однострочная ячейка: значение таблицы переносов и труб не несёт. */
function cell(text: string, max = 400): string {
  const one = text.replace(/\s*\r?\n\s*/g, '; ').trim();
  const cut = one.length > max ? `${one.slice(0, max)}…` : one;
  return escapeCell(cut) === '' ? '—' : escapeCell(cut);
}

/** Сплайс диапазона на новый текст. */
function splice(text: string, range: { start: number; end: number }, value: string): string {
  return text.slice(0, range.start) + value + text.slice(range.end);
}

/**
 * Строка выбранного варианта меню — целиком, с её собственным плейсхолдером или
 * значением, если у варианта был слот комментария. Ровно то, что делает `setDecision`
 * («заменяет всё после метки»): вторая ветка меню исчезает по построению, а не остаётся
 * рядом с чертой `/`.
 */
function renderChoice(field: FormField, value: Extract<SheetValue, { kind: 'choice' }>): string | null {
  const options = field.options ?? [];
  const opt = options.find((o) => o.key === value.key);
  if (opt === undefined) return null;
  if (!opt.commentSlot) return opt.text;
  // Слот комментария — тот же плейсхолдер, что был у варианта в тексте; подставляем
  // значение вместо него, остальной текст варианта (например, «— дыры: …») сохраняется.
  const ph = /‹[^›]*›/.exec(opt.text);
  if (ph === null) return opt.free ? value.comment : opt.text;
  return opt.text.slice(0, ph.index) + value.comment + opt.text.slice(ph.index + ph[0].length);
}

/**
 * Существующих строк того же поля в тексте, уже лежащем в артефакте — нужно при `op:'add'`,
 * чтобы механическая нумерация (`claim-N`) продолжала уже занятые id, а не начинала с
 * `claim-1` заново и не сталкивалась с тем, что уже стоит в файле.
 */
function countExistingRecords(existing: string, shape: FormField['shape']): number {
  if (shape === 'table') {
    return existing.split('\n').filter((l) => {
      const t = l.trim();
      return t.startsWith('|') && !isSeparatorRow(t);
    }).length;
  }
  return existing.split('\n').filter((l) => /^[-*+]\s/.test(l.trim())).length;
}

/** Записи `records`-поля по образцу поля: столько строк, сколько дал ответ. */
function renderRecords(field: FormField, rows: readonly Record<string, string>[], startIndex = 0): string {
  const columns = field.columns ?? [];
  if (field.shape === 'table') {
    return rows
      .map((row, i) => {
        const cells = columns.map((c) => {
          if (c.kind === 'mechanical') {
            // id пункта приёмки нумерует рантайм, продолжая уже занятые id, а не с нуля —
            // столкновение с «claim-2», уже стоящим в файле, дублировало бы имя.
            return c.id === 'id' || /claim/i.test(c.header)
              ? `claim-${startIndex + i + 1}`
              : String(startIndex + i + 1);
          }
          const raw = row[c.id] ?? '';
          if (c.kind === 'choice') {
            const m = matchChoice(c.options ?? [], raw);
            return cell(m === null ? raw : (c.options ?? []).find((o) => o.key === m.key)?.text ?? raw);
          }
          return cell(raw);
        });
        return `| ${cells.join(' | ')} |`;
      })
      .join('\n');
  }
  // records-список (`- ‹a› — ‹b›`): по образцу, тем же разделителем.
  const sepMatch = /\s+[—–]\s+/.exec(field.sample ?? '');
  const sep = sepMatch === null ? ' — ' : sepMatch[0];
  return rows
    .map((row) => `- ${columns.map((c) => row[c.id] ?? '').join(sep)}`)
    .join('\n');
}

function renderList(field: FormField, items: readonly string[]): string {
  const numbered = /^\s*\d+[.)]/.test(field.sample ?? '');
  return items.map((it, i) => (numbered ? `${i + 1}. ${it}` : `- ${it}`)).join('\n');
}

/**
 * Применяет значение к артефакту. Схема выводится заново из `text` — вызывающий не
 * держит устаревшего снимка. `null` op по умолчанию — `'set'`.
 */
export function applyFill(
  text: string,
  fieldId: string,
  raw: string,
  op: 'set' | 'add' = 'set',
  templateName?: string,
): ApplyOk | ApplyProblem {
  const schema = deriveSchema(text, templateName);
  const field = findField(schema, fieldId);
  if (field === undefined) {
    const ids = schema.fields
      .filter((f) => f.owner === 'model')
      .map((f) => f.id)
      .join(', ');
    return { ok: false, problem: `нет поля «${fieldId}» — доступные поля: ${ids || '(нет)'}` };
  }
  if (field.owner !== 'model') {
    return { ok: false, problem: `поле «${fieldId}» не заполняется моделью (${field.owner})` };
  }

  const value = parseFieldValue(field, raw);
  if (isSheetError(value)) return { ok: false, problem: value.error };

  switch (field.kind) {
    case 'scalar':
    case 'multiline': {
      if (value.kind !== 'text') return { ok: false, problem: `внутренняя ошибка: тип значения не совпал` };
      const rendered = field.singleLine === true ? value.text.replace(/\s*\r?\n\s*/g, ' ').trim() : value.text;
      return { ok: true, text: splice(text, field.placeholders[0] ?? field.valueRange, rendered), rendered };
    }

    case 'choice': {
      if (value.kind !== 'choice') return { ok: false, problem: `внутренняя ошибка: тип значения не совпал` };
      const rendered = renderChoice(field, value);
      if (rendered === null) return { ok: false, problem: `вариант «${value.key}» не найден среди меню поля` };
      return { ok: true, text: splice(text, field.valueRange, rendered), rendered };
    }

    case 'list': {
      if (value.kind !== 'list') return { ok: false, problem: `внутренняя ошибка: тип значения не совпал` };
      if (value.items.length === 0) {
        if (field.emptyAlternative !== undefined) {
          return { ok: true, text: splice(text, field.range, field.emptyAlternative), rendered: field.emptyAlternative };
        }
        return { ok: false, problem: `поле «${fieldId}»: список пуст, а альтернативы «пусто» у него нет` };
      }
      const rendered = renderList(field, value.items);
      if (op === 'add') {
        const merged = `${text.slice(field.range.start, field.range.end)}\n${rendered}`;
        return { ok: true, text: splice(text, field.range, merged), rendered };
      }
      return { ok: true, text: splice(text, field.range, rendered), rendered };
    }

    case 'records': {
      if (value.kind !== 'records') return { ok: false, problem: `внутренняя ошибка: тип значения не совпал` };
      if (value.rows.length === 0) {
        if (field.emptyAlternative !== undefined) {
          return { ok: true, text: splice(text, field.range, field.emptyAlternative), rendered: field.emptyAlternative };
        }
        return { ok: false, problem: `поле «${fieldId}»: записей нет, а альтернативы «пусто» у него нет` };
      }
      // Минимум листа приёмки (`CLAIMS_MINIMUM`) — сообщение об этом, не отказ: рантайм
      // не решает за рецензента этапа 1, он только называет факт, как fillField-описание.
      const min = field.min;
      const short = min !== undefined && value.rows.length < min.rows;
      if (op === 'add') {
        // Дописывает к уже стоящим строкам, а не заменяет их (см. описание `op` у
        // инструмента FillField в `toolSpecs.ts`) — для ЛЮБОЙ формы записей (таблица или
        // двухколоночные bullets), не только таблицы: обе рисуются той же строкой-на-строку
        // конкатенацией. Нумерация продолжает уже занятые id, а не начинает с `claim-1`.
        const existing = text.slice(field.range.start, field.range.end);
        const rendered = renderRecords(field, value.rows, countExistingRecords(existing, field.shape));
        const merged = `${existing}\n${rendered}`;
        return {
          ok: true,
          text: splice(text, field.range, merged),
          rendered: short ? `${rendered}\n(меньше минимума листа: ${min.rows})` : rendered,
        };
      }
      const rendered = renderRecords(field, value.rows);
      return {
        ok: true,
        text: splice(text, field.range, rendered),
        rendered: short ? `${rendered}\n(меньше минимума листа: ${min?.rows})` : rendered,
      };
    }

    default:
      return { ok: false, problem: `поле «${fieldId}» не заполняется через FillField (${field.kind})` };
  }
}
