/**
 * Показать, что именно изменится, ДО того как это произойдёт.
 *
 * Одобрять запись по одному пути бессмысленно: агент может записать в правильный файл
 * неправильное содержимое. Поэтому в панель уходит пара «текущее ↔ предлагаемое», а не
 * только имя файла.
 */

import { existsSync, readFileSync } from 'node:fs';

import { resolveUserPath } from '../policy/paths.ts';
import type { DiffPreview, NormalizedCall } from '../types.ts';

export class EditApplyError extends Error {}

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
      throw new EditApplyError(`фрагмент не найден в файле: «${preview(e.oldStr)}»`);
    }

    if (e.replaceAll) {
      text = text.split(e.oldStr).join(e.newStr);
      continue;
    }

    const second = text.indexOf(e.oldStr, first + e.oldStr.length);
    if (second >= 0) {
      throw new EditApplyError(
        `фрагмент встречается несколько раз: «${preview(e.oldStr)}». ` +
          'Нужен более длинный контекст либо replace_all.',
      );
    }
    text = text.slice(0, first) + e.newStr + text.slice(first + e.oldStr.length);
  }
  return text;
}

function preview(s: string): string {
  const line = s.split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** `null` — вызов ничего не пишет, показывать нечего. */
export function buildPreview(call: NormalizedCall, projectRoot: string): DiffPreview | null {
  if (call.kind === 'write') {
    const abs = resolveUserPath(projectRoot, call.path);
    const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    return { path: call.path, before, after: call.content };
  }

  if (call.kind === 'edit') {
    const abs = resolveUserPath(projectRoot, call.path);
    if (!existsSync(abs)) {
      // Edit по несуществующему файлу — сам по себе дефект вызова; покажем как есть.
      return { path: call.path, before: null, after: '' };
    }
    const before = readFileSync(abs, 'utf8');
    try {
      return { path: call.path, before, after: applyEdits(before, call.edits) };
    } catch (e) {
      // Предпросмотр не собрался — оператору важнее увидеть причину, чем пустую панель.
      return { path: call.path, before, after: `‹правка не применяется: ${(e as Error).message}›` };
    }
  }

  return null;
}
