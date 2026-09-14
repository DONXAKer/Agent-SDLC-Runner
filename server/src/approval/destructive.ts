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
import { decisionLabelsIn, decisionLineIndexes } from '../artifacts/artifact.ts';
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

/** Больше этого файл целиком ради проверки не читается — сравнение идёт по размеру. */
const MAX_READ_BYTES = 4_000_000;

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
 * Метки полей решений, которых в `after` стало МЕНЬШЕ, чем в `before`, — по числу
 * вхождений, а не по множеству меток: из двух записей handoff с «Кто утвердил» перезапись
 * могла стереть одну, и сравнение множеств этой потери не видело. Метка в ответе одна на
 * сколько бы полей с ней ни пропало — это имя для оператора, а не счёт.
 */
function lostDecisionLabels(beforeLines: readonly string[], afterLines: readonly string[], before: string): string[] {
  return decisionLabelsIn(before).filter(
    (label) => decisionLineIndexes(afterLines, label).length < decisionLineIndexes(beforeLines, label).length,
  );
}

/**
 * Потеря при замене текста `before` на `content` — чистая часть `destructiveOverwrite`.
 * Отдельно от чтения, чтобы починка (`repairErasedDecisions`) считала потерю по тому же
 * тексту, который уже прочла, а не заставляла гейт читать файл ещё раз.
 */
function overwriteLoss(path: string, before: string, content: string): DestructiveOverwrite | null {
  const linesBefore = lineCount(before);
  const linesAfter = lineCount(content);

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
  const decisionsLost = lostDecisionLabels(before.split('\n'), content.split('\n'), before);
  if (decisionsLost.length > 0) {
    return { path, linesBefore, linesAfter, linesLost: linesBefore - linesAfter, decisionsLost };
  }

  if (linesBefore < MIN_LINES) return null;

  const linesLost = linesBefore - linesAfter;
  if (linesLost <= 0) return null;
  if (linesLost / linesBefore < LOSS_RATIO) return null;

  return { path, linesBefore, linesAfter, linesLost };
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
 * Прежний текст файла под `Write`. `null` в `text` — файла нет, он не файл или нечитаем
 * (терять нечего); `huge` — слишком велик, чтобы читать ради проверки.
 */
function readBefore(projectRoot: string, path: string): { text: string } | { huge: number } | null {
  const abs = resolveUserPath(projectRoot, path);
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null; // файла нет — это создание, терять нечего
  }
  if (size > MAX_READ_BYTES) return { huge: size };
  try {
    return { text: readFileSync(abs, 'utf8') };
  } catch {
    return null;
  }
}

/**
 * Потеря гигантского файла — по размеру. Сравнение ОБЯЗАТЕЛЬНО: безусловный возврат
 * «разрушающая перезапись» объявлял потерей дописывание строки в пятимегабайтный файл, где
 * содержимое растёт, и показывал оператору утверждение «прежнее содержимое будет потеряно»,
 * которое просто неверно.
 */
function hugeLoss(path: string, size: number, content: string): DestructiveOverwrite | null {
  const after = Buffer.byteLength(content, 'utf8');
  if (after >= size * LOSS_RATIO) return null;
  return { path, linesBefore: -1, linesAfter: lineCount(content), linesLost: -1 };
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

  const before = readBefore(projectRoot, call.path);
  if (before === null) return null;
  if ('huge' in before) return hugeLoss(call.path, before.huge, call.content);
  return overwriteLoss(call.path, before.text, call.content);
}

/**
 * Потеря по строкам сама по себе разрушительна — вне зависимости от полей решений.
 * Тогда новая версия может оказаться мусором, и чинить её вставкой поля нельзя.
 *
 * Короткий файл здесь НЕ исключение, в отличие от `MIN_LINES` у ноты: файл в 35 строк,
 * переписанный в 3 со стёртым полем, — тоже мусор, и «починка» вставкой поля выдала бы его
 * за исправленную запись. Абсолютный порог для короткого файла — `MIN_LINES_FIELD`: он
 * отделяет потерю документа от правки пары строк рядом с полем.
 */
export function isMassLoss(d: DestructiveOverwrite): boolean {
  if (d.linesBefore < 0) return true;
  if (d.linesLost <= 0 || d.linesBefore === 0) return false;
  if (d.linesLost / d.linesBefore < LOSS_RATIO) return false;
  return d.linesBefore >= MIN_LINES || d.linesLost >= MIN_LINES_FIELD;
}

const HEADING = /^#{1,6}\s/;

/** Порядковый номер строки среди строк с тем же текстом (без учёта пробелов по краям). */
function ordinalOf(lines: readonly string[], at: number): number {
  const text = lines[at]!.trim();
  let k = 0;
  for (let i = 0; i < at; i++) if (lines[i]!.trim() === text) k++;
  return k;
}

/** Индекс k-й строки с этим текстом, `-1` — такой нет. */
function nthIndexOf(lines: readonly string[], text: string, k: number): number {
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== text) continue;
    if (seen === k) return i;
    seen++;
  }
  return -1;
}

/**
 * Возвращает в новое содержимое поля решений человека, стёртые перезаписью.
 *
 * Блок поля (строка метки и её строки-продолжения) переносится из прежнего текста дословно
 * — в конец той же секции, если её заголовок уцелел, иначе в конец документа: поле ищется
 * по метке (`readDecision`), место в документе машине не важно. `null` — вернуть нельзя
 * безопасно: после вставки полей с какой-то меткой всё ещё меньше, чем было.
 *
 * Три урока ревью:
 *  - считается ЧИСЛО полей с меткой, а не её наличие: из двух «Кто утвердил» handoff'а
 *    возвращалось одно, и финальная проверка по множеству меток проходила;
 *  - секция находится по ПОРЯДКОВОМУ номеру своего заголовка: у записей о дефектах
 *    подзаголовки одинаковы, и первое совпадение во всём документе уводило поле в чужую
 *    запись;
 *  - перевод строки берётся у нового содержимого: блок из CRLF-файла, вставленный в LF-текст
 *    как есть, оставлял смешанные переводы строк.
 */
export function restoreLostDecisions(before: string, content: string): { content: string; restored: string[] } | null {
  const src = before.split('\n').map((l) => l.replace(/\r$/, ''));
  // CRLF — только если ВЕСЬ текст в CRLF: смешанный текст модели не нормализуется, в него
  // лишь вставляется LF-блок, как в любой LF-текст.
  const crlf = content.includes('\r\n') && !/(^|[^\r])\n/.test(content);
  const out = crlf ? content.split('\r\n') : content.split('\n');

  // Какие ВХОЖДЕНИЯ пропали: у каждой метки — недостающие по числу. Выбираются те, чей
  // текст в новом содержимом не встречается (их модель и стёрла), а при нехватке таких —
  // последние по порядку: какое из одинаковых полей стёрто, по тексту уже не различить.
  const missing: { label: string; at: number }[] = [];
  const restored: string[] = [];
  for (const label of decisionLabelsIn(before)) {
    const inSrc = decisionLineIndexes(src, label);
    const inOut = decisionLineIndexes(out, label);
    const need = inSrc.length - inOut.length;
    if (need <= 0) continue;
    const outTexts = inOut.map((i) => out[i]!.replace(/\r$/, '').trim());
    const unmatched: number[] = [];
    const matched: number[] = [];
    for (const i of inSrc) {
      const pos = outTexts.indexOf(src[i]!.trim());
      if (pos >= 0) {
        outTexts.splice(pos, 1);
        matched.push(i);
      } else {
        unmatched.push(i);
      }
    }
    // Одинаковых меток несколько, а стёртые по тексту не опознаются однозначно (модель
    // изменила одну запись и стёрла другую; тексты полей совпадают) — угадывать нельзя:
    // поле ушло бы в чужую запись, и проверка по числу меток это пропустила бы.
    if (inSrc.length > 1 && unmatched.length !== need) return null;
    const chosen = [...unmatched, ...matched.reverse()].slice(0, need);
    for (const at of chosen) missing.push({ label, at });
    restored.push(label);
  }
  if (missing.length === 0) return null;

  // В порядке исходного документа: поля одной секции встают в неё в прежнем порядке.
  missing.sort((a, b) => a.at - b.at);
  for (const { at } of missing) {
    let end = at + 1;
    while (end < src.length && /^\s+\S/.test(src[end]!)) end++;
    const block = src.slice(at, end);

    let h = at - 1;
    while (h >= 0 && !HEADING.test(src[h]!)) h--;
    // Порядковый номер заголовка переносим, только если одинаковых заголовков столько же:
    // модель удалила или переименовала одну из одинаковых секций — k-я в новом тексте уже
    // чужая запись, либо её нет, и поле молча ушло бы в конец документа.
    if (h >= 0) {
      const heading = src[h]!.trim();
      const count = (lines: readonly string[]): number => lines.filter((l) => l.trim() === heading).length;
      const inSrc = count(src);
      // Единственный заголовок, пропавший целиком, — не угадывание: поле уходит в конец
      // документа и по метке читается. Угадывание — только среди одинаковых.
      if (inSrc > 1 && inSrc !== count(out)) return null;
    }
    const hIdx = h < 0 ? -1 : nthIndexOf(out, src[h]!.trim(), ordinalOf(src, h));

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

  const repaired = out.join(crlf ? '\r\n' : '\n');
  const after = repaired.split('\n');
  for (const label of restored) {
    if (decisionLineIndexes(after, label).length < decisionLineIndexes(src, label).length) return null;
  }
  return { content: repaired, restored };
}

export interface ErasedDecisionsCheck {
  /** Потеря ИСХОДНОГО вызова — до починки. По ней оператору и метрике видно, что стиралось. */
  loss: DestructiveOverwrite | null;
  /** `null` — чинить нечего или нельзя. */
  repair: {
    content: string;
    restored: string[];
    /** Потеря исправленного содержимого — то, что остаётся показать оператору нотой. */
    residual: DestructiveOverwrite | null;
  } | null;
}

/**
 * Перезапись, стёршая поле решения человека, — с возвращённым полем вместо отказа.
 *
 * Серия v4: 21 такой отказ в 11 прогонах из 25 — модель переписывает отчёт разведки `Write`
 * целиком и теряет «Решение человека о полноте», которое заполнять и не должна была. Отказ
 * стоил хода и не учил ничему; поле, которое модели не принадлежит, возвращает механика.
 * Только когда больше ничего не теряется: при массовой потере строк новая версия может быть
 * мусором, и решать остаётся человеку прежним путём.
 *
 * Только `Write`, не `FillField`, и это не пробел: `applyFill` отказывается писать в поле,
 * владелец которого не модель, — стереть поле решения через `FillField` нельзя по
 * построению, и чинить там нечего.
 *
 * Файл читается ОДИН раз, и потеря исходного вызова возвращается вместе с починкой: гейт
 * берёт её отсюда, а не зовёт `destructiveOverwrite` повторно (прежде один `Write` читал
 * файл до пяти раз).
 */
export function repairErasedDecisions(call: NormalizedCall, projectRoot: string): ErasedDecisionsCheck {
  if (call.kind !== 'write') return { loss: null, repair: null };
  const before = readBefore(projectRoot, call.path);
  if (before === null) return { loss: null, repair: null };
  if ('huge' in before) return { loss: hugeLoss(call.path, before.huge, call.content), repair: null };

  const loss = overwriteLoss(call.path, before.text, call.content);
  if (loss === null || loss.decisionsLost === undefined || loss.decisionsLost.length === 0) return { loss, repair: null };
  if (isMassLoss(loss)) return { loss, repair: null };
  // Потеря структуры — тоже мусор при любом размере файла: пороги по строкам короткий
  // бланк (9 строк → 1) массовой потерей не считают, и «починка» вставкой поля выдала бы
  // одну строку мусора за исправленную запись.
  const headings = (t: string): number => t.split('\n').filter((l) => HEADING.test(l)).length;
  const headingsBefore = headings(before.text);
  if (headingsBefore >= 2 && headings(call.content) * 2 < headingsBefore) return { loss, repair: null };

  const fixed = restoreLostDecisions(before.text, call.content);
  if (fixed === null) return { loss, repair: null };
  return { loss, repair: { ...fixed, residual: overwriteLoss(call.path, before.text, fixed.content) } };
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
