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
 * Что НЕ делается: файлы не защищаются от записи агентом. Ему полезно записать туда своё
 * понимание по ходу дела, и запрет породил бы отказы там, где достаточно перезаписи.
 */

import { writeFileSync } from 'node:fs';

import { workingDiff } from '../gates/git.ts';
import type { BuiltinGate, GateContext } from '../gates/builtin/index.ts';

export interface EvidenceResult {
  /** Патч, каким он лёг на диск. Пустая строка — дерево не изменилось. */
  diff: string;
  /** Первая строка записи о тестах — для журнала событий. */
  testsNote: string;
}

/**
 * Перезаписывает патч и запись о тестах фактами.
 *
 * `runTests` передаётся параметром, а не берётся из реестра здесь: этап 5 и этап 6 гоняют
 * один и тот же гейт «Тесты», и подмена его на тесте — единственный способ проверить эту
 * функцию, не запуская чужой тест-раннер.
 */
export async function recordAttemptEvidence(args: {
  projectRoot: string;
  diffPath: string;
  testsPath: string;
  gateCtx: GateContext;
  runTests: BuiltinGate | null;
  signal?: AbortSignal;
}): Promise<EvidenceResult> {
  const diff = await workingDiff(args.projectRoot, [], args.signal);
  const header =
    diff.trim() === ''
      ? '# правок в дереве нет: этап не изменил ни одного файла\n'
      : `# патч перегенерирован рантаймом из рабочего дерева (${new Date().toISOString()})\n`;
  writeFileSync(args.diffPath, header + diff, 'utf8');

  let testsNote: string;
  if (args.runTests === null) {
    testsNote = 'гейт «Тесты» в наборе не найден — рантайм тестов не запускал';
    writeFileSync(args.testsPath, `${testsNote}\n`, 'utf8');
  } else {
    const outcome = await args.runTests(args.gateCtx);
    testsNote = `${outcome.status} ${outcome.command ?? 'встроенная реализация'} (код ${outcome.exitCode ?? '—'})`;
    // Заголовок обязателен: без него файл читается как рассказ исполнителя, а весь смысл
    // правки в том, что читатель видит, КТО его составил.
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
    ].join('\n');
    writeFileSync(args.testsPath, text, 'utf8');
  }

  return { diff, testsNote };
}
