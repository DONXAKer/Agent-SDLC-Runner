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

/**
 * Ответ несёт плейсхолдер бланка (`‹что делаем›` внутри ответа): вклеенный, он оставлял бы
 * место незаполненным под видом заполненного — то же правило, что у некомпактного пути.
 */
const PLACEHOLDER_IN_ANSWER = /‹[^›\n]*›/;

/** Сплайс диапазона на новый текст. */
function splice(text: string, range: { start: number; end: number }, value: string): string {
  return text.slice(0, range.start) + value + text.slice(range.end);
}

/**
 * Конец строки документа — `\r\n` или `\n`. Шаблоны эталона лежат с `\r\n`; склейка
 * многострочных значений (`renderList`/`renderRecords`) через голый `\n` давала файл со
 * смешанными концами строк (ревью code-review-all, 2026-09-11: подтверждено прогоном на
 * реальном `exploration-report.template.md`).
 */
function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
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

/**
 * Записи `records`-поля по образцу поля: столько строк, сколько дал ответ. `eol` — конец
 * строки ДОКУМЕНТА, а не образца: образец однострочен почти всегда (`| ‹a› | ‹b› |`) и
 * своего `\r\n` не несёт, поэтому определять его по образцу значило бы всегда получать
 * голый `\n` и смешивать концы строк с окружающим CRLF-текстом (ревью code-review-all,
 * 2026-09-11, подтверждено прогоном на реальном шаблоне эталона).
 */
function renderRecords(field: FormField, rows: readonly Record<string, string>[], eol: string, startIndex = 0): string {
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
      .join(eol);
  }
  // records-список (`- ‹a› — ‹b›`): по образцу, тем же разделителем.
  const sepMatch = /\s+[—–]\s+/.exec(field.sample ?? '');
  const sep = sepMatch === null ? ' — ' : sepMatch[0];
  return rows
    .map((row) => `- ${columns.map((c) => row[c.id] ?? '').join(sep)}`)
    .join(eol);
}

/**
 * Статичное окружение образца вокруг ПЕРВОГО плейсхолдера (`- [ ] **[блокирующий]** ‹вопрос›`
 * → префикс `- [ ] **[блокирующий]** `, суффикс ``) — то, что образец несёт помимо самого
 * значения. Без этого `renderList` рисовал голое `- item` и терял чек-бокс/метку списка,
 * которые сам список несёт в разметке, а не в тексте элемента (ревью code-review-all,
 * 2026-09-11: `applyFill('всплывшие вопросы', …)` терял `- [ ] **[блокирующий]**`, из-за
 * чего `hasOpenQuestions` не видел записанный вопрос). Единый префикс не различает
 * варианты образца («блокирующий» vs «неблокирующий») — это ограничение самого
 * проводного формата `FillField` (список несёт только значения, не типы строк), но
 * маркер `- [ ]`, от которого зависит `hasOpenQuestions`, сохраняется всегда.
 */
function listAffixes(sample: string | undefined): { prefix: string; suffix: string } {
  const marker = /^\s*[-*+]\s+/.exec(sample ?? '');
  if (marker === null) return { prefix: '- ', suffix: '' };
  const rest = (sample ?? '').slice(marker[0].length);
  const ph = /‹[^›]*›/.exec(rest);
  if (ph === null) return { prefix: marker[0], suffix: '' };
  return { prefix: marker[0] + rest.slice(0, ph.index), suffix: rest.slice(ph.index + ph[0].length) };
}

/** `eol` — конец строки документа, тем же приёмом, что у `renderRecords`. */
function renderList(field: FormField, items: readonly string[], eol: string): string {
  if (/^\s*\d+[.)]/.test(field.sample ?? '')) {
    return items.map((it, i) => `${i + 1}. ${it}`).join(eol);
  }
  const { prefix, suffix } = listAffixes(field.sample);
  return items.map((it) => `${prefix}${it}${suffix}`).join(eol);
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
  const eol = eolOf(text);
  const schema = deriveSchema(text, templateName);
  const field = findField(schema, fieldId);
  if (field === undefined) {
    // Диагностика называет ПРИЧИНУ, а не вываливает весь бланк. Самый частый случай —
    // не «такого поля нет», а «поле то же, id сдвинулся»: id несёт номер раздела
    // (`uniqueId`), и у соседа с той же меткой он меняется по мере заполнения. Разбор
    // серии v9 (2026-09-15): во всех пяти прогонах нота гласила «нет поля
    // «необходимое/единичное»» и печатала следом шестнадцать идентификаторов, среди
    // которых стояли `необходимое/1`, `необходимое/однозначное` — то есть подсказка
    // была, но утонула в списке.
    // `group` («### Запись N») не заполняется через `FillField` в принципе (см. ниже,
    // ветка `field.owner !== 'model'` аналог — тут тот же класс, только `kind`, а не
    // `owner`) — как и канонический `modelFields()`, список подсказки его не предлагает:
    // предложенный id всё равно откажет второй, не относящейся к делу причиной.
    const model = schema.fields.filter((f) => f.owner === 'model' && f.kind !== 'group');
    // Модель пишет id словом из своей головы, не из бланка: «точка_правки» вместо
    // «точка правки» (та же серия v14) — подчёркивание/дефис вместо пробела считаем тем
    // же самым словом, иначе именно этот, самый частый в живых логах, промах в near не
    // попадёт и уйдёт в общий список ниже.
    const label = (id: string): string =>
      (id.split('/').pop() ?? id)
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const targetLabel = label(fieldId);
    const near = model.filter((f) => label(f.id) === targetLabel);
    // Поле, ждущее ответа, — то, что несёт хоть один плейсхолдер (`f.placeholders`, тот же
    // массив, что уже посчитал `deriveSchema` — ср. `finalizeCheck.ts`). Для `choice` этот
    // сигнал ненадёжен: часть меню бланк пишет голым словом без `‹…›` (`MENU_TOKENS`,
    // «Контур: полный / мелкий», «Действие: н/п / конструкция / …») — такое поле не покажет
    // ни одного плейсхолдера, даже нетронутое, а незаполненный выбор — обычное дело на
    // каждом первом проходе. Оставлять его в подсказке рискованно (заслонит собой РЕАЛЬНО
    // заполненные поля), а прятать — куда хуже (разбор v15, 2026-09-16: «Контур» на
    // девственно чистом intent.template.md пропадал из подсказки вовсе). Поэтому `choice`
    // считается открытым всегда; жертвуем только редким обратным случаем — когда `choice`
    // уже ответили, но разбор меню не удержал вложенный плейсхолдер-пример в одной из
    // веток и поле «воскресло» с обрывком старой ветки (`formSchema.ts::menuOptionsOfValue`,
    // отдельный, не этой правкой заведённый дефект) — там сортировка не поможет, как и до
    // неё.
    const unfilled = (f: FormField): boolean => f.kind === 'choice' || f.placeholders.length > 0;
    // Та же теснота — не только в общем списке: общая метка колонки таблицы (например
    // «статус» у каждой строки readiness.template.md, 12 совпадений) даёт `near` того же
    // размера, что и «доступные поля», и раньше не сортировалась и не считала остаток
    // вовсе — разбор v15, 2026-09-16.
    const candidates = near.length > 0 ? near : model;
    const ordered = [...candidates].sort((a, b) => Number(unfilled(b)) - Number(unfilled(a)));
    const shown = ordered.slice(0, 8).map((f) => f.id);
    const what = near.length > 0 ? 'поле с такой меткой есть под другим id' : 'доступные поля';
    const more = candidates.length > shown.length ? ` (и ещё ${candidates.length - shown.length})` : '';
    return { ok: false, problem: `нет поля «${fieldId}» — ${what}: ${shown.join(', ') || '(нет)'}${more}` };
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
      if (value.text.trim() === '') return { ok: false, problem: `поле «${fieldId}»: пустой ответ` };
      if (PLACEHOLDER_IN_ANSWER.test(value.text)) {
        return { ok: false, problem: `поле «${fieldId}»: ответ несёт плейсхолдер бланка ‹…› вместо значения` };
      }
      // Ячейка таблицы — через `cell()`: переносы склеиваются, `|` экранируется. Прежде
      // скаляр-ячейка вклеивался как есть, и `|` в ответе ломал строку таблицы.
      const rendered =
        field.shape === 'cell'
          ? cell(value.text)
          : field.singleLine === true
            ? value.text.replace(/\s*\r?\n\s*/g, ' ').trim()
            : value.text;
      return { ok: true, text: splice(text, field.placeholders[0] ?? field.valueRange, rendered), rendered };
    }

    case 'choice': {
      if (value.kind !== 'choice') return { ok: false, problem: `внутренняя ошибка: тип значения не совпал` };
      if (PLACEHOLDER_IN_ANSWER.test(value.comment)) {
        return { ok: false, problem: `поле «${fieldId}»: комментарий несёт плейсхолдер бланка ‹…›` };
      }
      if (value.comment !== '') {
        value.comment =
          field.shape === 'cell'
            ? cell(value.comment)
            : field.singleLine === true
              ? value.comment.replace(/\s*\r?\n\s*/g, ' ').trim()
              : value.comment;
      }
      const rendered = renderChoice(field, value);
      if (rendered === null) return { ok: false, problem: `вариант «${value.key}» не найден среди меню поля` };
      return { ok: true, text: splice(text, field.valueRange, rendered), rendered };
    }

    case 'list': {
      if (value.kind !== 'list') return { ok: false, problem: `внутренняя ошибка: тип значения не совпал` };
      if (value.items.some((it) => PLACEHOLDER_IN_ANSWER.test(it))) {
        return { ok: false, problem: `поле «${fieldId}»: пункт списка несёт плейсхолдер бланка ‹…›` };
      }
      if (value.items.length === 0) {
        if (field.emptyAlternative !== undefined) {
          return { ok: true, text: splice(text, field.range, field.emptyAlternative), rendered: field.emptyAlternative };
        }
        return { ok: false, problem: `поле «${fieldId}»: список пуст, а альтернативы «пусто» у него нет` };
      }
      const rendered = renderList(field, value.items, eol);
      if (op === 'add') {
        const merged = `${text.slice(field.range.start, field.range.end)}${eolOf(text)}${rendered}`;
        return { ok: true, text: splice(text, field.range, merged), rendered };
      }
      return { ok: true, text: splice(text, field.range, rendered), rendered };
    }

    case 'records': {
      if (value.kind !== 'records') return { ok: false, problem: `внутренняя ошибка: тип значения не совпал` };
      if (value.rows.some((row) => Object.values(row).some((v) => PLACEHOLDER_IN_ANSWER.test(v)))) {
        return { ok: false, problem: `поле «${fieldId}»: запись несёт плейсхолдер бланка ‹…›` };
      }
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
        const rendered = renderRecords(field, value.rows, eol, countExistingRecords(existing, field.shape));
        const merged = `${existing}${eolOf(text)}${rendered}`;
        return {
          ok: true,
          text: splice(text, field.range, merged),
          rendered: short ? `${rendered}\n(меньше минимума листа: ${min.rows})` : rendered,
        };
      }
      const rendered = renderRecords(field, value.rows, eol);
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
