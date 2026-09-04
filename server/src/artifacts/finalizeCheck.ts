/**
 * Проверка «можно ли финализировать артефакт» — общая для обоих флоу (`loop`/`sdk`), см.
 * `case`/`tool` `finalize_artifact` в `LoopExecutor.ts`/`SdkExecutor.ts`. Раньше каждый
 * флоу решал это по-своему: `loop` проверял (путь артефакта / существование / голый
 * счётчик плейсхолдеров), `sdk` не проверял НИЧЕГО — разъезд с инвариантом «два флоу —
 * одна форма вызова и одно решение политики» (`CLAUDE.md`). Здесь — одна функция на обе
 * стороны; текст успеха каждый флоу по-прежнему строит сам (он и раньше был разным
 * между ними, это не предмет этого фикса).
 *
 * Локализация незаполненных мест — отдельная причина завести общий код, не только
 * устранить дублирование: отказ, называющий только ЧИСЛО мест
 * (`readArtifact().placeholders`), заставлял слабую модель заново сканировать весь
 * документ, чтобы их найти, и когда это не выходило, «переписать файл целиком»
 * выглядело надёжнее точечной правки (живой случай: `destructiveOverwrite` поймал
 * именно такую попытку на `explore`, `docs/model-runs.md`, 2026-09-03). Локализация не
 * требует нового разбора: `deriveSchema()` уже строит по любому markdown-тексту список
 * полей с секцией/меткой/подсказкой — этот модуль просто не выбрасывает их, как делал
 * голый `countPlaceholders()`.
 */

import { isAbsolute, join } from 'node:path';

import { readArtifact } from './artifact.ts';
import { deriveSchema } from './formSchema.ts';
import { templateNameFor } from '../run/seed.ts';

export interface MissingPlaceholders {
  /** То же число, что дал бы `countPlaceholders(text)` — второго понятия не заводится. */
  count: number;
  /**
   * По одной строке на ПОЛЕ (секция + метка/подсказка), не по одной на голый `‹…›` —
   * иначе таблица с десятком пустых строк одного вида съела бы весь список.
   */
  located: string[];
}

const MAX_LOCATED = 5;

export function describeMissingPlaceholders(text: string, templateName: string | null): MissingPlaceholders {
  const schema = deriveSchema(text, templateName ?? undefined);
  const withGaps = schema.fields.filter((f) => f.placeholders.length > 0);
  const count = withGaps.reduce((n, f) => n + f.placeholders.length, 0);
  const located = withGaps.slice(0, MAX_LOCATED).map((f) => `«${f.section}»: ${f.label ?? f.hint}`);
  if (withGaps.length > MAX_LOCATED) located.push(`и ещё ${withGaps.length - MAX_LOCATED} мест`);
  return { count, located };
}

/**
 * Решает, можно ли финализировать артефакт, названный моделью строкой `artifactArg`.
 * `null` — можно (артефакт этапа, существует, плейсхолдеров нет); строка — готовый
 * текст отказа, который флоу возвращает модели как есть.
 *
 * Путь резолвится тем же приёмом, что у любой другой ссылки модели на файл этапа:
 * абсолютный — как есть, иначе — от корня проекта. `formArtifacts` — уже переданный
 * рантаймом список артефактов ЭТОГО этапа (`ExecRequest.formArtifacts`); пустой список
 * — исторический случай «этап не объявил свои артефакты», проверка по нему не ведётся.
 */
export function finalizeRejection(
  artifactArg: string,
  projectRoot: string,
  formArtifacts: readonly string[],
): string | null {
  const p = isAbsolute(artifactArg) ? artifactArg : join(projectRoot, artifactArg);
  if (formArtifacts.length > 0 && !formArtifacts.includes(p)) {
    return (
      `ошибка: «${artifactArg}» не является артефактом этого этапа — финализируй ` +
      `один из: ${formArtifacts.join(', ')}`
    );
  }
  const a = readArtifact(p);
  if (!a.exists) {
    return `ошибка: артефакт ${artifactArg} не существует — сначала запиши его, потом финализируй`;
  }
  if (a.placeholders > 0) {
    const { located } = describeMissingPlaceholders(a.text, templateNameFor(p));
    return (
      `ошибка: в ${artifactArg} осталось незаполненных мест ‹…›: ${a.placeholders} — ` +
      `${located.join('; ')}. Замени именно их инструментом Edit (не переписывай файл ` +
      `целиком) и вызови FinalizeArtifact снова`
    );
  }
  return null;
}
