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

import { basename } from 'node:path';

import { readArtifact } from './artifact.ts';
import { deriveSchema } from './formSchema.ts';
import { isWindowsStyle, lexicalNormalize, pathsEqual, relativizeWithin, resolveUserPath } from '../policy/paths.ts';
import { templateNameFor } from '../run/seed.ts';

export interface MissingPlaceholders {
  /**
   * То же число, что дал бы `countPlaceholders(text)` — второго понятия не заводится;
   * с `exceptDecisions` — то же число без полей решений человека.
   */
  count: number;
  /**
   * По одной строке на ПОЛЕ (секция + метка/подсказка), не по одной на голый `‹…›` —
   * иначе таблица с десятком пустых строк одного вида съела бы весь список.
   */
  located: string[];
}

const MAX_LOCATED = 5;

/**
 * `exceptDecisions` — не считать и не называть поля решений человека («Подтвердил»,
 * «Одобрение», подписные колонки): их заполняет оператор ПОСЛЕ этапа (`Run.recordDecision`),
 * а запись модели в них отклоняет `humanDecision.ts`. Отказ, называвший такое поле, гнал
 * модель ровно на отклоняемую запись: живой прогон gpt-oss-20b 2026-09-24 — «незаполненных
 * мест: 2 — «место правки»: подтвердил. Замени именно их инструментом Edit» и следом 7
 * отказов политики по одному и тому же полю. Счёт в этом режиме — по тем же полям, что и
 * список, а не отдельным `countPlaceholdersExceptDecisions`: тот не видит подписных
 * колонок таблиц, и число разошлось бы с перечнем.
 */
export function describeMissingPlaceholders(
  text: string,
  templateName: string | null,
  exceptDecisions = false,
): MissingPlaceholders {
  const schema = deriveSchema(text, templateName ?? undefined);
  const withGaps = schema.fields.filter(
    (f) => f.placeholders.length > 0 && !(exceptDecisions && f.kind === 'decision'),
  );
  const count = withGaps.reduce((n, f) => n + f.placeholders.length, 0);
  const located = withGaps.slice(0, MAX_LOCATED).map((f) => `«${f.section}»: ${f.label ?? f.hint}`);
  if (withGaps.length > MAX_LOCATED) located.push(`и ещё ${withGaps.length - MAX_LOCATED} мест`);
  return { count, located };
}

export interface FinalizeRejection {
  message: string;
  /**
   * Незаполненных мест на момент ЭТОГО отказа — `undefined`, если отказ не про
   * плейсхолдеры (не тот артефакт / не существует). Число, а не булев признак:
   * вызывающий код (детектор застревания `explore`, `LoopExecutor.ts`) сравнивает его
   * между отказами, чтобы отличить «правится, но медленно» от «стоит на месте».
   */
  placeholders?: number;
  /**
   * То же самое `located`, что уже вошло текстом в `message` (по одной строке на поле) —
   * отдельным полем для детектора застревания: итоговое сообщение об антицикле раньше
   * называло только ЧИСЛО мест на каждом отказе («30 → 30 → 30»), не сами поля, и человек,
   * читающий трассу, не видел, что именно застряло, не читая сырые вызовы FinalizeArtifact
   * по одному.
   */
  located?: string[];
}

/**
 * Решает, можно ли финализировать артефакт, названный моделью строкой `artifactArg`.
 * `null` — можно (артефакт этапа, существует, плейсхолдеров нет); иначе — готовый текст
 * отказа (флоу возвращает его модели как есть) и, если причина — плейсхолдеры, их число.
 *
 * Путь резолвится тем же приёмом, что у любой другой ссылки модели на файл этапа
 * (`resolveUserPath`: абсолютный — как есть, иначе — от корня проекта; пробелы по краям и
 * обратные слэши гасятся). Не совпал ни с одним артефактом этапа — ищется по базовому
 * имени, тем же правилом, что `approval/artifactAddress.ts` для записи: голое имя, слаг с
 * опечаткой, ведущий пробел, `\` вместо `/` — это ошибка АДРЕСАЦИИ, и заявка принимается по
 * каноническому пути. Живой прогон gpt-oss-20b 2026-09-24: 7 отказов «не является артефактом
 * этого этапа» на ` .sdlc/…/chunk-1-journal.md`, `chunk-1-journal.md`, `\.sdlc\/…` и на
 * корне `D:/Проекты/agent-sdlc/…`, взятом из строки промпта про каталог форм. Последний —
 * путь ВНЕ проекта, и он не переадресуется: это не адресация, а выход за границу.
 *
 * `formArtifacts` — уже переданный рантаймом список артефактов ЭТОГО этапа
 * (`ExecRequest.formArtifacts`); пустой список — исторический случай «этап не объявил свои
 * артефакты», проверка по нему не ведётся.
 */
export function finalizeRejection(
  artifactArg: string,
  projectRoot: string,
  formArtifacts: readonly string[],
): FinalizeRejection | null {
  const p = resolveArtifactPath(artifactArg, projectRoot, formArtifacts);
  if (p === null) {
    return {
      message:
        `ошибка: «${artifactArg}» не является артефактом этого этапа — финализируй ` +
        `один из: ${formArtifacts.join(', ')}`,
    };
  }
  const a = readArtifact(p);
  if (!a.exists) {
    return { message: `ошибка: артефакт ${artifactArg} не существует — сначала запиши его, потом финализируй` };
  }
  const { count, located } = describeMissingPlaceholders(a.text, templateNameFor(p), true);
  if (count > 0) {
    return {
      message:
        `ошибка: в ${artifactArg} осталось незаполненных мест ‹…›: ${count} — ` +
        `${located.join('; ')}. Замени именно их инструментом Edit (не переписывай файл ` +
        `целиком) и вызови FinalizeArtifact снова. Поля решений человека (Подтвердил, ` +
        `Одобрение и подобные) не в счёт — их заполняет оператор`,
      placeholders: count,
      located,
    };
  }
  return null;
}

/**
 * Путь артефакта, который модель имела в виду: канонический из `formArtifacts`, либо
 * `null`, когда назван не артефакт этапа. Без списка — как назвала модель.
 */
function resolveArtifactPath(artifactArg: string, projectRoot: string, formArtifacts: readonly string[]): string | null {
  const abs = resolveUserPath(projectRoot, artifactArg);
  if (formArtifacts.length === 0) return abs;
  const ci = isWindowsStyle(projectRoot);
  const exact = formArtifacts.find((f) => pathsEqual(lexicalNormalize(f), abs, ci));
  if (exact !== undefined) return exact;
  if (relativizeWithin(projectRoot, abs) === null) return null;
  const requestedRel = relativizeWithin(projectRoot, abs);
  if (requestedRel !== null) {
    const malformed = formArtifacts.find((f) => {
      const canonicalRel = relativizeWithin(projectRoot, lexicalNormalize(f));
      if (canonicalRel === null || !pathsEqual(canonicalRel.split('/')[0] ?? '', '.sdlc', ci)) return false;
      const slash = canonicalRel.lastIndexOf('/');
      if (slash < 0) return false;
      const dir = canonicalRel.slice(0, slash);
      const file = canonicalRel.slice(slash + 1);
      return [`${dir}(${file}`, `${dir}(${file})`].some((typo) => pathsEqual(requestedRel, typo, ci));
    });
    if (malformed !== undefined) return malformed;
  }
  const name = basename(abs);
  if (name === '') return null;
  return formArtifacts.find((f) => pathsEqual(basename(lexicalNormalize(f)), name, ci)) ?? null;
}
