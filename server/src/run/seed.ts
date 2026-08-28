/**
 * Скелет артефакта кладётся на диск ДО этапа, а не сочиняется моделью на нём.
 *
 * Наблюдение живого прогона: пять локальных моделей подряд дошли до чтения формы и
 * завершили ход, ничего не записав. Задача «создай документ по форме» для 4–35B оказалась
 * другого класса сложности, чем «заполни поля в готовом файле», а два прогона вдобавок
 * попытались притащить форму в проект копированием через оболочку.
 *
 * Поэтому рантайм копирует форму сам. Копируется ТОЛЬКО отсутствующее: существующий
 * артефакт — это работа человека или прошлого этапа, и затирать её формой значит стирать
 * решение, которое уже принято.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Имя формы для артефакта. Номера chunk'а и попытки в именах форм не участвуют: форма
 * одна на весь класс артефактов.
 */
export function templateNameFor(artifactPath: string): string {
  const name = basename(artifactPath).replace(/\.md$/i, '');

  const chunkJournal = /^chunk-\d+-journal$/.exec(name);
  if (chunkJournal !== null) return 'chunk-journal.template.md';

  const verification = /^verification-report-\d+-attempt-\d+$/.exec(name);
  if (verification !== null) return 'verification-report.template.md';

  return `${name}.template.md`;
}

export interface SeededArtifact {
  path: string;
  template: string;
}

/**
 * Разложить формы под отсутствующие артефакты этапа.
 *
 * Возвращает то, что действительно скопировано, — вызывающий обязан сказать об этом и
 * оператору, и модели: файл, появившийся сам собой, иначе читается как чужая работа.
 */
export function seedArtifacts(
  produces: readonly string[],
  methodologyDir: string,
): SeededArtifact[] {
  const seeded: SeededArtifact[] = [];

  for (const path of produces) {
    if (existsSync(path)) continue;

    const template = join(methodologyDir, 'templates', templateNameFor(path));
    // Формы нет — это не ошибка: эталон может не описывать такой артефакт, и модель
    // напишет его сама, как писала до сих пор.
    if (!existsSync(template)) continue;

    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(template, path);
    seeded.push({ path, template });
  }

  return seeded;
}

/**
 * Бланк, который так и остался бланком: файл есть, но байт в байт равен форме.
 *
 * Поймано на первом же прогоне после раскладки форм: проверка «файла нет» стала
 * бессмысленной ровно потому, что рантайм сам его и создал. Незаполненный бланк — это не
 * сделанная работа, и признак у него точный, без догадок по содержимому.
 */
export function untouchedSeeds(seeded: readonly SeededArtifact[]): string[] {
  return seeded
    .filter((s) => {
      if (!existsSync(s.path) || !existsSync(s.template)) return false;
      return readFileSync(s.path, 'utf8') === readFileSync(s.template, 'utf8');
    })
    .map((s) => s.path);
}

/**
 * Артефакты этапа, которых не было до его запуска и не появилось после.
 *
 * Сравнение именно с состоянием ДО: у этапа 1 в списке производимого есть набор гейтов
 * проекта, который обычно существует задолго до витка, — считать его доказательством
 * работы этапа нельзя.
 */
export function stillMissing(
  produces: readonly string[],
  missingBefore: readonly string[],
): string[] {
  return produces.filter((p) => missingBefore.includes(p) && !existsSync(p));
}

/** Те из производимых артефактов, которых на диске ещё нет. Снимок до запуска этапа. */
export function missingNow(produces: readonly string[]): string[] {
  return produces.filter((p) => !existsSync(p));
}
