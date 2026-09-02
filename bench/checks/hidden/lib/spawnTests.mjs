/**
 * Прогон набора тестов ЦЕЛИ дочерним процессом — для скрытых тестов, которые судят не
 * функцию, а сам набор: появился ли новый тест (`characterization`), починен ли неверный
 * ассерт (`broken-test`), перестал ли набор мигать (`flaky-by-design`).
 *
 * Сам спавн — общий с обвязкой (`bench/src/nodeTest.ts`): там же гасятся
 * `NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID`, иначе дочерний узел считает себя «внутри уже
 * идущего прогона» и молча пропускает файлы. Здесь — только разбор сводки TAP.
 */

import { spawnNodeTest } from '../../../src/nodeTest.ts';

const SUMMARY_RE = /^# (pass|fail|tests|skipped|todo|cancelled) (\d+)$/u;

/** Одиночный прогон `node --test --test-reporter=tap <pattern>` в каталоге цели. */
export async function runTargetTestsOnce(target, { pattern = 'test/**/*.test.ts', timeoutMs = 120_000 } = {}) {
  const out = await spawnNodeTest({ testArgs: [pattern], cwd: target, timeoutMs });
  const summary = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 };
  for (const line of out.stdout.split('\n')) {
    const m = SUMMARY_RE.exec(line.trim());
    if (m !== null) summary[m[1]] = Number(m[2]);
  }
  return { exitCode: out.exitCode, timedOut: out.timedOut, stdout: out.stdout, stderr: out.stderr, ...summary };
}

/**
 * Зелёный прогон: код 0, ни одного упавшего, ни одного отменённого И ни одного `todo` —
 * `t.todo()` на падающем тесте даёт код 0 и `# fail 0`, то есть «починить» неверный ассерт
 * можно было бы, просто пометив его todo. Пустой набор (`tests 0`) зелёным тоже не считается.
 */
export function isGreenRun(r) {
  return r.exitCode === 0 && r.fail === 0 && r.cancelled === 0 && r.todo === 0 && r.tests > 0;
}

/**
 * `times` прогонов подряд. Нужен мигающим наборам: один зелёный прогон набора с вероятностью
 * падения 0.4 ничего не доказывает, восемь подряд — доказывают с ложной зеленью 0.6^8 ≈ 1.7 %.
 */
export async function runTargetTests(target, { times = 1, ...opts } = {}) {
  const runs = [];
  for (let i = 0; i < times; i += 1) runs.push(await runTargetTestsOnce(target, opts));
  const greenRuns = runs.filter(isGreenRun).length;
  return { runs, greenRuns, allGreen: greenRuns === runs.length };
}
