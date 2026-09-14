/**
 * Разрушающая перезапись: `Write` поверх существующего файла, теряющий большую часть его.
 *
 * Замер этапа 5 на локальной модели (`docs/model-runs.md`): исполнитель позвал `Write` по
 * файлу из плана и заменил 1235 строк одиннадцатистрочной заглушкой. Политика не возразила
 * и не должна была — путь в плане, запись законна. Правило автоодобрения «правки внутри
 * плана» тоже сработало как написано. То есть дыра не в проверке пути, а в том, что
 * «записать в файл плана» и «стереть файл плана» проходили одним и тем же решением.
 *
 * Здесь считается только ФАКТ потери, а не намерение: заменить файл целиком — законная
 * операция (перегенерация, свёртка), и запрещать её нельзя. Нельзя — делать её молча.
 *
 * Не про `Edit`: точечная замена фрагмента не может потерять файл целиком, и превью её
 * показывает построчно. Не про новый файл: терять там нечего.
 */

import { readFileSync, statSync } from 'node:fs';

import { applyFill } from '../artifacts/applyFill.ts';
import { decisionLabelsIn, isDecisionLine } from '../artifacts/artifact.ts';
import { deriveSchema, findField } from '../artifacts/formSchema.ts';
import { resolveUserPath } from '../policy/paths.ts';
import { templateNameFor } from '../run/seed.ts';
import type { ArtifactKey, NormalizedCall } from '@sdlc-runner/shared';

/**
 * Порог доли потерянного. 0.5 — не «половина важнее сорока процентов», а точка, ниже
 * которой перезапись перестаёт быть перезаписью по существу: файл, ужатый вдвое одним
 * вызовом, оператор обязан увидеть, а обычная правка столько не теряет.
 */
const LOSS_RATIO = 0.5;

/**
 * Ниже этого числа строк потеря не считается разрушительной.
 *
 * Без него каждая правка короткого файла (`.gitignore` в 6 строк, однострочный конфиг)
 * требовала бы отдельного решения человека, и правило стало бы шумом, который выключают.
 */
const MIN_LINES = 40;

/**
 * Тот же порог для поля `FillField`, а не для файла целиком: поле по природе короче
 * документа, вокруг него всегда стоит остальное содержимое артефакта, которое в `MIN_LINES`
 * файла и не заметит потерю. Число взято из failure_scenario ревью — «десятки накопленных
 * строк» листа/списка, а не сотни.
 */
const MIN_LINES_FIELD = 10;

export interface DestructiveOverwrite {
  path: string;
  linesBefore: number;
  linesAfter: number;
  /** Сколько строк исчезает. Число, а не доля: доля не проверяется глазами. */
  linesLost: number;
  /** Поле артефакта, если разрушение — по `FillField`, а не по `Write` файла целиком. */
  field?: string;
  /**
   * Поля РЕШЕНИЙ ЧЕЛОВЕКА, исчезающие из артефакта. Считаются отдельно от строк: их
   * потеря разрушительна при любом объёме записи.
   */
  decisionsLost?: string[];
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const n = text.split('\n').length;
  // Хвостовой перевод строки — не строка: без этой поправки файл из 10 строк с финальным
  // `\n` считался бы одиннадцатистрочным, и сравнение «до/после» перекашивало бы на файлах,
  // где правка как раз этот перевод и добавляет.
  return text.endsWith('\n') ? n - 1 : n;
}

/**
 * Та же проверка для `FillField`: `op: 'set'` заменяет диапазон поля целиком (`applyFill`),
 * и это тот же класс потери, что `Write` поверх файла — только масштабом в поле, не в
 * документ. `op: 'add'` дописывает и терять нечего по построению (см. `applyFill.ts`).
 */
function fillFieldLoss(
  call: NormalizedCall & { kind: 'fill_field' },
  projectRoot: string,
  stageArtifacts: readonly { key: ArtifactKey; path: string }[],
): DestructiveOverwrite | null {
  if (call.op !== 'set') return null;

  const entry = stageArtifacts.find((a) => a.key === call.artifact);
  if (entry === undefined) return null;

  let before: string;
  try {
    before = readFileSync(resolveUserPath(projectRoot, entry.path), 'utf8');
  } catch {
    return null;
  }

  const templateName = templateNameFor(entry.path);
  const schema = deriveSchema(before, templateName);
  const field = findField(schema, call.field);
  if (field === undefined) return null;

  const applied = applyFill(before, call.field, call.value, call.op, templateName);
  if (!applied.ok) return null;

  const linesBefore = lineCount(before.slice(field.range.start, field.range.end));
  const linesAfter = lineCount(applied.rendered);
  if (linesBefore < MIN_LINES_FIELD) return null;

  const linesLost = linesBefore - linesAfter;
  if (linesLost <= 0) return null;
  if (linesLost / linesBefore < LOSS_RATIO) return null;

  return { path: entry.path, linesBefore, linesAfter, linesLost, field: call.field };
}

/**
 * `null` — вызов не разрушающий: не `Write`/`FillField`, файла нет, он нечитаем, слишком
 * короток либо потеря ниже порога.
 *
 * Чтение файла здесь допустимо по той же причине, по какой оно допустимо в `buildPreview`:
 * функция вызывается ПОСЛЕ разрешения политики, то есть по пути, который агенту и так
 * открыт на запись.
 */
export function destructiveOverwrite(
  call: NormalizedCall,
  projectRoot: string,
  stageArtifacts: readonly { key: ArtifactKey; path: string }[] = [],
): DestructiveOverwrite | null {
  if (call.kind === 'fill_field') return fillFieldLoss(call, projectRoot, stageArtifacts);
  if (call.kind !== 'write') return null;

  const abs = resolveUserPath(projectRoot, call.path);

  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null; // файла нет — это создание, терять нечего
  }

  // Гигантский файл не читаем целиком ради проверки — сравниваем по размеру. Сравнение
  // ОБЯЗАТЕЛЬНО: безусловный возврат «разрушающая перезапись» объявлял потерей дописывание
  // строки в пятимегабайтный файл, где содержимое растёт, и показывал оператору
  // утверждение «прежнее содержимое будет потеряно», которое просто неверно.
  if (size > 4_000_000) {
    const after = Buffer.byteLength(call.content, 'utf8');
    if (after >= size * LOSS_RATIO) return null;
    return { path: call.path, linesBefore: -1, linesAfter: lineCount(call.content), linesLost: -1 };
  }

  let before: string;
  try {
    before = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }

  const linesBefore = lineCount(before);
  const linesAfter = lineCount(call.content);

  // Потеря поля решения ЧЕЛОВЕКА — разрушение независимо от объёма: доля строк её не
  // видит, а цена измерена. Замер 2026-09-04 (14 витков `polza:ministral-14b` по
  // семействам фикстур): модель правит отчёт разведки серией `Edit`, а в конце
  // перезаписывает файл целиком — текст выходит НЕ короче, порог доли молчит, и вместе с
  // ним исчезает «Решение человека о полноте». Этап отчитывался `ok`, виток умирал через
  // этап на предусловии `explore`, и модель узнавала о своей ошибке сообщением, по
  // которому её уже не связать с собственным `Write`. Пять задач из четырнадцати.
  //
  // Поле решения не «большая часть содержимого» — оно вообще не содержимое модели:
  // заполняет его человек, и стирать его молча нельзя ни при каком размере правки.
  // Обе стороны считаются по одному разу: `decisionLabelsIn` сканирует текст построчно, и
  // вызов внутри filter означал бы полный проход по новому содержимому на каждую метку.
  const after = new Set<string>(decisionLabelsIn(call.content));
  const decisionsLost = decisionLabelsIn(before).filter((label) => !after.has(label));
  if (decisionsLost.length > 0) {
    return { path: call.path, linesBefore, linesAfter, linesLost: linesBefore - linesAfter, decisionsLost };
  }

  if (linesBefore < MIN_LINES) return null;

  const linesLost = linesBefore - linesAfter;
  if (linesLost <= 0) return null;
  if (linesLost / linesBefore < LOSS_RATIO) return null;

  return { path: call.path, linesBefore, linesAfter, linesLost };
}

/**
 * Потеря по строкам сама по себе разрушительна — вне зависимости от полей решений.
 * Тогда новая версия может оказаться мусором, и чинить её вставкой поля нельзя.
 */
export function isMassLoss(d: DestructiveOverwrite): boolean {
  if (d.linesBefore < 0) return true;
  return d.linesBefore >= MIN_LINES && d.linesLost > 0 && d.linesLost / d.linesBefore >= LOSS_RATIO;
}

const HEADING = /^#{1,6}\s/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Возвращает в новое содержимое поля решений человека, стёртые перезаписью.
 *
 * Блок поля (строка метки и её строки-продолжения) переносится из прежнего текста дословно
 * — в конец той же секции, если её заголовок уцелел, иначе в конец документа: поле ищется
 * по метке (`readDecision`), место в документе машине не важно. `null` — вернуть нельзя
 * безопасно: метка не нашлась построчно или после вставки поле всё ещё не читается.
 */
export function restoreLostDecisions(before: string, content: string): { content: string; restored: string[] } | null {
  const have = new Set<string>(decisionLabelsIn(content));
  const lost = decisionLabelsIn(before).filter((label) => !have.has(label));
  if (lost.length === 0) return null;

  const src = before.split('\n');
  const out = content.split('\n');
  for (const label of lost) {
    const re = new RegExp(`\\*\\*\\s*${escapeRe(label)}`, 'i');
    const at = src.findIndex((l) => re.test(l) && isDecisionLine(l));
    if (at < 0) return null;
    let end = at + 1;
    while (end < src.length && /^\s+\S/.test(src[end]!)) end++;
    const block = src.slice(at, end);

    let h = at - 1;
    while (h >= 0 && !HEADING.test(src[h]!)) h--;
    const heading = h >= 0 ? src[h]!.trim() : null;
    const hIdx = heading === null ? -1 : out.findIndex((l) => l.trim() === heading);

    let insertAt: number;
    if (hIdx < 0) {
      insertAt = out.length;
    } else {
      insertAt = hIdx + 1;
      while (insertAt < out.length && !HEADING.test(out[insertAt]!)) insertAt++;
    }
    const floor = hIdx < 0 ? 0 : hIdx + 1;
    while (insertAt > floor && out[insertAt - 1]!.trim() === '') insertAt--;
    const prev = insertAt > 0 ? out[insertAt - 1]! : '';
    const lead = prev.trim() !== '' && !/^\s*[-*+]\s/.test(prev) ? [''] : [];
    const tail = insertAt < out.length && out[insertAt]!.trim() !== '' ? [''] : [];
    out.splice(insertAt, 0, ...lead, ...block, ...tail);
  }

  const repaired = out.join('\n');
  const after = new Set<string>(decisionLabelsIn(repaired));
  if (!lost.every((label) => after.has(label))) return null;
  return { content: repaired, restored: lost };
}

/**
 * Перезапись, стёршая поле решения человека, — с возвращённым полем вместо отказа.
 *
 * Серия v4: 21 такой отказ в 11 прогонах из 25 — модель переписывает отчёт разведки `Write`
 * целиком и теряет «Решение человека о полноте», которое заполнять и не должна была. Отказ
 * стоил хода и не учил ничему; поле, которое модели не принадлежит, возвращает механика.
 * Только когда больше ничего не теряется: при массовой потере строк новая версия может быть
 * мусором, и решать остаётся человеку прежним путём. `null` — чинить нечего или нельзя.
 */
export function repairErasedDecisions(
  call: NormalizedCall,
  projectRoot: string,
): { content: string; restored: string[] } | null {
  if (call.kind !== 'write') return null;
  const loss = destructiveOverwrite(call, projectRoot);
  if (loss === null || loss.decisionsLost === undefined || loss.decisionsLost.length === 0) return null;
  if (isMassLoss(loss)) return null;
  let before: string;
  try {
    before = readFileSync(resolveUserPath(projectRoot, call.path), 'utf8');
  } catch {
    return null;
  }
  return restoreLostDecisions(before, call.content);
}

/** Строка для оператора и для журнала событий. Числа, а не оценка: «−1233 строки». */
export function destructiveNote(d: DestructiveOverwrite): string {
  if (d.decisionsLost !== undefined && d.decisionsLost.length > 0) {
    const fields = d.decisionsLost.map((f) => `«${f}»`).join(', ');
    return (
      `перезапись ${d.path} стирает поле решения человека: ${fields}. Это поле заполняет ` +
      `человек, а не модель: верни его в текст (правь фрагмент через Edit, а не переписывай файл целиком)`
    );
  }
  if (d.linesBefore < 0) {
    return `перезапись очень большого файла ${d.path} целиком — прежнее содержимое будет потеряно`;
  }
  if (d.field !== undefined) {
    return (
      `запись поля «${d.field}» ${d.path} теряет большую часть его содержимого: было ` +
      `${d.linesBefore} строк, станет ${d.linesAfter} (−${d.linesLost}). Автоодобрение на такой вызов не распространяется`
    );
  }
  return (
    `перезапись ${d.path} целиком: было ${d.linesBefore} строк, станет ${d.linesAfter} ` +
    `(−${d.linesLost}). Автоодобрение на такой вызов не распространяется`
  );
}
