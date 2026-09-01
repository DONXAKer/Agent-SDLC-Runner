/**
 * Прогон набора тестов ЦЕЛИ дочерним процессом — для скрытых тестов, которые судят не
 * функцию, а сам набор: появился ли новый тест (`characterization`), починен ли неверный
 * ассерт (`broken-test`), перестал ли набор мигать (`flaky-by-design`).
 *
 * Приём — из `bench/src/hiddenTests.ts`: `NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID` наследуются
 * от родителя, когда вызывающий сам запущен из-под `node --test` (а скрытый тест — всегда),
 * и дочерний узел молча пропускает файлы, считая себя «внутри уже идущего прогона». Обе
 * переменные гасятся, иначе набор цели «проходит» с нулём тестов.
 */

import { spawn } from 'node:child_process';

const SUMMARY_RE = /^# (pass|fail|tests|skipped|todo|cancelled) (\d+)$/u;

/** Одиночный прогон `node --test --test-reporter=tap <pattern>` в каталоге цели. */
export function runTargetTestsOnce(target, { pattern = 'test/**/*.test.ts', timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const { NODE_TEST_CONTEXT: _ctx, NODE_TEST_WORKER_ID: _worker, ...cleanEnv } = process.env;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', pattern], {
      cwd: target,
      env: cleanEnv,
      windowsHide: true,
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d.toString('utf8')));
    child.stderr.on('data', (d) => err.push(d.toString('utf8')));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = out.join('');
      const summary = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 };
      for (const line of stdout.split('\n')) {
        const m = SUMMARY_RE.exec(line.trim());
        if (m !== null) summary[m[1]] = Number(m[2]);
      }
      resolve({ exitCode: code, stdout, stderr: err.join(''), ...summary });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: '', stderr: e.message, tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 });
    });
  });
}

/**
 * `times` прогонов подряд. Нужен мигающим наборам: один зелёный прогон набора с вероятностью
 * падения 0.4 ничего не доказывает, восемь подряд — доказывают с ложной зеленью 0.6^8 ≈ 1.7 %.
 * `allGreen` — каждый прогон дал `fail === 0`, `tests > 0` и код 0.
 */
export async function runTargetTests(target, { times = 1, ...opts } = {}) {
  const runs = [];
  for (let i = 0; i < times; i += 1) runs.push(await runTargetTestsOnce(target, opts));
  const greenRuns = runs.filter((r) => r.exitCode === 0 && r.fail === 0 && r.tests > 0).length;
  return { runs, greenRuns, allGreen: greenRuns === runs.length };
}
