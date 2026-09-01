/**
 * Свидетельства попытки производит рантайм, а не агент.
 *
 * Замер этапа 5 (`docs/model-runs.md`): исполнитель написал
 * `chunk-1-attempt-1-tests.txt` со строками «PASS ✓ Case 1: Not a repository (5ms)», ни
 * разу не запустив тесты, и `chunk-1-attempt-1-diff.patch`, объявляющий файл удалённым и
 * ссылающийся на несуществующий путь. Оба файла — вход этапа 6. Рецензент, получивший их
 * как данность, судил бы по сочинённому.
 *
 * Дыра здесь не в модели. Пока «улику» пишет тот, чью работу она удостоверяет, вопрос
 * только в том, когда именно её подделают. Поэтому оба файла перезаписываются рантаймом
 * из фактического состояния дерева и фактического прогона — то, что записал агент,
 * свидетельством не считается и в этап 6 не попадает.
 *
 * **В патч не дописывается ничего.** Первая версия ставила в начало служебную шапку с
 * `new Date().toISOString()` — и этим убила безусловный детект топтания: `detectNoProgress`
 * сравнивает патчи двух попыток ДОСЛОВНО, а таймстамп различен всегда. Файл обязан быть
 * побайтово тем, что печатает git: он сверяется и с деревом, и с патчем прошлой попытки.
 * Всё, что рантайм хочет сказать о записи, он говорит событием, а не строкой в улике.
 */

import { writeFileSync } from 'node:fs';

import { workingDiff } from '../gates/git.ts';
import type { BuiltinGate, GateContext } from '../gates/builtin/index.ts';

/**
 * Что стало с деревом за эту попытку.
 *
 * `unknown` — отдельное значение, а не «считаем, что правки были»: если патч посчитать не
 * удалось, исход попытки неизвестен, и прятать это в `changed` значит открывать ровно ту
 * дыру, ради закрытия которой улики и отобраны у агента.
 */
export type TreeChange = 'changed' | 'empty' | 'unknown';

export interface EvidenceResult {
  tree: TreeChange;
  /** Первая строка записи о тестах — для журнала событий. */
  testsNote: string;
  /** Тот же текст, что лёг в `diffPath` — вызывающему он нужен ещё раз (сверка с планом). */
  diff: string;
}

/**
 * Перезаписывает патч и запись о тестах фактами.
 *
 * `diffBefore` — патч рабочего дерева на момент СТАРТА этапа. Без него «дерево не
 * изменилось» считалось бы против HEAD, а коммита до этапа 7 не бывает: правки прошлой
 * попытки и прошлого chunk'а всё ещё в дереве, и попытка, не сделавшая ничего, выглядела
 * бы результативной.
 *
 * `runTests` передаётся параметром, а не берётся из реестра здесь: этап 5 и этап 6 обязаны
 * гонять один и тот же гейт «Тесты» — тот, что назван в наборе проекта.
 */
export async function recordAttemptEvidence(args: {
  projectRoot: string;
  diffPath: string;
  testsPath: string;
  diffBefore: string;
  gateCtx: GateContext;
  runTests: BuiltinGate | null;
  signal?: AbortSignal;
}): Promise<EvidenceResult> {
  const diff = await workingDiff(args.projectRoot, [], args.signal);
  writeFileSync(args.diffPath, diff, 'utf8');

  const tree: TreeChange = diff.trim() === args.diffBefore.trim() ? 'empty' : 'changed';

  let testsNote: string;
  if (args.runTests === null) {
    testsNote = 'гейт «Тесты» в наборе не найден — рантайм тестов не запускал';
    writeFileSync(args.testsPath, `${testsNote}\n`, 'utf8');
  } else {
    const outcome = await args.runTests(args.gateCtx);
    testsNote = `${outcome.status} ${outcome.command ?? 'встроенная реализация'} (код ${outcome.exitCode ?? '—'})`;
    // Заголовок обязателен: без него файл читается как рассказ исполнителя, а весь смысл
    // правки в том, что читатель видит, КТО его составил. В патче такого заголовка нет —
    // тот сверяется побайтово, а этот файл только читают.
    const text = [
      '# Запись рантайма о фактическом прогоне тестов этой попытки.',
      '# Составлена не исполнителем этапа: содержимое, записанное агентом, перезаписано.',
      '',
      `Команда: ${outcome.command ?? 'встроенная реализация гейта'}`,
      `Статус: ${outcome.status}`,
      `Код возврата: ${outcome.exitCode ?? '—'}`,
      '',
      outcome.lastLine,
      '',
      // Хвост фактического вывода: без него следующая попытка чинила падения вслепую —
      // имена упавших тестов и трейсбеки не были видны ни исполнителю, ни рецензенту.
      ...(outcome.outputTail === undefined || outcome.outputTail.trim() === ''
        ? []
        : ['## Вывод команды (хвост, записан рантаймом)', '', outcome.outputTail, '']),
    ].join('\n');
    writeFileSync(args.testsPath, text, 'utf8');
  }

  return { tree, testsNote, diff };
}
