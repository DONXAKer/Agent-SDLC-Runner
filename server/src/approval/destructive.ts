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

import { resolveUserPath } from '../policy/paths.ts';
import type { NormalizedCall } from '@sdlc-runner/shared';

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

export interface DestructiveOverwrite {
  path: string;
  linesBefore: number;
  linesAfter: number;
  /** Сколько строк исчезает. Число, а не доля: доля не проверяется глазами. */
  linesLost: number;
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
 * `null` — вызов не разрушающий: не `Write`, файла нет, он нечитаем, слишком короток либо
 * потеря ниже порога.
 *
 * Чтение файла здесь допустимо по той же причине, по какой оно допустимо в `buildPreview`:
 * функция вызывается ПОСЛЕ разрешения политики, то есть по пути, который агенту и так
 * открыт на запись.
 */
export function destructiveOverwrite(
  call: NormalizedCall,
  projectRoot: string,
): DestructiveOverwrite | null {
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

  // Гигантский файл не читаем целиком ради проверки: по размеру видно и так, а память
  // панели одобрения дороже точности порога.
  if (size > 4_000_000) {
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
  if (linesBefore < MIN_LINES) return null;

  const linesLost = linesBefore - linesAfter;
  if (linesLost <= 0) return null;
  if (linesLost / linesBefore < LOSS_RATIO) return null;

  return { path: call.path, linesBefore, linesAfter, linesLost };
}

/** Строка для оператора и для журнала событий. Числа, а не оценка: «−1233 строки». */
export function destructiveNote(d: DestructiveOverwrite): string {
  if (d.linesBefore < 0) {
    return `перезапись очень большого файла ${d.path} целиком — прежнее содержимое будет потеряно`;
  }
  return (
    `перезапись ${d.path} целиком: было ${d.linesBefore} строк, станет ${d.linesAfter} ` +
    `(−${d.linesLost}). Автоодобрение на такой вызов не распространяется`
  );
}
