/**
 * Показать, что именно изменится, ДО того как это произойдёт.
 *
 * Одобрять запись по одному пути бессмысленно: агент может записать в правильный файл
 * неправильное содержимое. Поэтому в панель уходит пара «текущее ↔ предлагаемое», а не
 * только имя файла.
 *
 * Вызывается только после того, как политика разрешила вызов: чтение файла ради
 * предпросмотра — это чтение файла, и делать его для отклонённой записи нельзя.
 */

import { readFileSync, statSync } from 'node:fs';

import { applyFill } from '../artifacts/applyFill.ts';
import { findLooseRange } from '../exec/editMatch.ts';
import { resolveUserPath } from '../policy/paths.ts';
import { templateNameFor } from '../run/seed.ts';
import type { ArtifactKey, DiffPreview, NormalizedCall } from '@sdlc-runner/shared';

export class EditApplyError extends Error {}

/** Больше этого предпросмотр не строим: панель одобрения не должна вешать вкладку. */
const MAX_PREVIEW_BYTES = 400_000;

/**
 * Применяет правки так же, как это сделает инструмент. Если фрагмент не найден или
 * встречается несколько раз — это ошибка, и оператор должен увидеть её сейчас, а не
 * получить молча испорченный файл.
 */
export function applyEdits(
  source: string,
  edits: readonly { oldStr: string; newStr: string; replaceAll: boolean }[],
): string {
  let text = source;
  for (const e of edits) {
    if (e.oldStr === '') throw new EditApplyError('пустой old_string — нечего заменять');

    const first = text.indexOf(e.oldStr);
    if (first < 0) {
      // Тот же запасной путь, что у инструмента (`exec/editMatch.ts`). Обе стороны обязаны
      // применять правку ОДИНАКОВО: разойдись они — предпросмотр показывал бы оператору
      // ошибку там, где запись пройдёт, и одобрять он стал бы не то, что случится.
      const loose = e.replaceAll ? 'none' : findLooseRange(text, e.oldStr);
      if (typeof loose === 'object') {
        text = text.slice(0, loose.start) + e.newStr + text.slice(loose.end);
        continue;
      }
      throw new EditApplyError(
        loose === 'ambiguous'
          ? `фрагмент с точностью до переносов строк подходит больше одного места: «${snippet(e.oldStr)}»`
          : `фрагмент не найден в файле: «${snippet(e.oldStr)}»`,
      );
    }

    if (e.replaceAll) {
      text = text.split(e.oldStr).join(e.newStr);
      continue;
    }

    const second = text.indexOf(e.oldStr, first + e.oldStr.length);
    if (second >= 0) {
      throw new EditApplyError(
        `фрагмент встречается несколько раз: «${snippet(e.oldStr)}». ` +
          'Нужен более длинный контекст либо replace_all.',
      );
    }
    text = text.slice(0, first) + e.newStr + text.slice(first + e.oldStr.length);
  }
  return text;
}

function snippet(s: string): string {
  const line = s.split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** Текущее содержимое файла, либо `null` — файла нет, слишком велик или недоступен. */
function readCurrent(abs: string): { text: string | null; note: string | null } {
  let size: number;
  try {
    const st = statSync(abs);
    if (st.isDirectory()) {
      return { text: null, note: 'по этому пути каталог, а не файл' };
    }
    size = st.size;
  } catch {
    return { text: null, note: null }; // файла ещё нет — это создание
  }

  if (size > MAX_PREVIEW_BYTES) {
    return { text: null, note: `файл ${Math.round(size / 1024)} КБ — предпросмотр не строится` };
  }

  try {
    return { text: readFileSync(abs, 'utf8'), note: null };
  } catch (e) {
    return { text: null, note: `файл недоступен: ${(e as Error).message}` };
  }
}

/**
 * `null` — вызов ничего не пишет, показывать нечего.
 *
 * `stageArtifacts` — только для `fill_field`: путь у него не в самом вызове, а в карте
 * ключей этапа (та же, что решала доступ политикой). Оператор видит ОТРЕНДЕРЕННЫЙ
 * результат — `applyFill` уже нарисовал markdown, значит панель показывает ровно то, что
 * ляжет на диск, а не сырое значение поля.
 */
export function buildPreview(
  call: NormalizedCall,
  projectRoot: string,
  stageArtifacts: readonly { key: ArtifactKey; path: string }[] = [],
): DiffPreview | null {
  if (call.kind === 'fill_field') {
    const entry = stageArtifacts.find((a) => a.key === call.artifact);
    if (entry === undefined) return null; // политика уже отклонила бы такой вызов раньше
    const current = readCurrent(entry.path);
    if (current.text === null) {
      return { path: entry.path, before: null, after: `‹бланк не найден: ${current.note ?? 'файла нет'}›` };
    }
    const applied = applyFill(current.text, call.field, call.value, call.op, templateNameFor(entry.path));
    if (!applied.ok) {
      return { path: entry.path, before: current.text, after: `‹значение не применяется: ${applied.problem}›` };
    }
    return { path: entry.path, before: current.text, after: applied.text };
  }

  if (call.kind !== 'write' && call.kind !== 'edit') return null;

  const abs = resolveUserPath(projectRoot, call.path);
  const current = readCurrent(abs);

  if (call.kind === 'write') {
    if (current.note !== null) {
      return { path: call.path, before: null, after: `‹${current.note}›\n\n${call.content}` };
    }
    return { path: call.path, before: current.text, after: call.content };
  }

  if (current.text === null) {
    return {
      path: call.path,
      before: null,
      after: `‹правка невозможна: ${current.note ?? 'файла нет'}›`,
    };
  }

  try {
    return { path: call.path, before: current.text, after: applyEdits(current.text, call.edits) };
  } catch (e) {
    // Предпросмотр не собрался — оператору важнее увидеть причину, чем пустую панель.
    return {
      path: call.path,
      before: current.text,
      after: `‹правка не применяется: ${(e as Error).message}›`,
    };
  }
}
