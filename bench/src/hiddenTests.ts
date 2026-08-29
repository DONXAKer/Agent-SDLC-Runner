/**
 * Запуск скрытых тестов (шаг 5/7 ROADMAP.md) дочерним процессом.
 *
 * Тонкая обвязка ввода-вывода вокруг чистых `bench/checks/hidden/*.hidden.mjs`: сама
 * функция ничего не решает, только спрашивает `node --test` и разбирает TAP-вывод.
 * Держится отдельно от `report.ts`, чтобы форматирование отчёта проверялось без единого
 * дочернего процесса.
 */

import { spawn } from 'node:child_process';

export interface HiddenCaseResult {
  id: string;
  category: string;
  ok: boolean;
  label: string;
}

export interface HiddenTestsSummary {
  total: number;
  pass: number;
  fail: number;
  cases: HiddenCaseResult[];
  /** Пусто, если процесс завершился нормально (упавшие тесты — это `cases`, не это поле). */
  errorText: string | null;
}

/** `ok 3 - H1 [human] (claim-5): текст` / `not ok 4 - Pr2 [precision] (claim-3): текст`. */
const TAP_LINE_RE = /^(ok|not ok)\s+\d+\s+-\s+(\S+)\s+\[(\w+)\]/u;

function parseTap(stdout: string): HiddenCaseResult[] {
  const cases: HiddenCaseResult[] = [];
  for (const line of stdout.split('\n')) {
    const m = TAP_LINE_RE.exec(line.trim());
    if (m === null) continue;
    cases.push({ ok: m[1] === 'ok', id: m[2]!, category: m[3]!, label: line.trim() });
  }
  return cases;
}

/**
 * Запускает один файл скрытых тестов против целевого дерева (`BENCH_TARGET_DIR` — путь,
 * где лежит `src/`, обычно копия рабочей копии витка ПОСЛЕ chunk'а, снятая на одноразовой
 * копии — см. комментарий в самом `.hidden.mjs`).
 */
export function runHiddenTests(args: { hiddenFile: string; targetDir: string; timeoutMs?: number }): Promise<HiddenTestsSummary> {
  return new Promise((resolve) => {
    // `--test-reporter=tap`: репортёр по умолчанию (`spec`) не даёт машиночитаемых строк
    // «ok N - имя» — только символы ✔/✖ для терминала. TAP — единственный штатный формат,
    // который парсится регуляркой, а не угадыванием по эмодзи.
    // `NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID` наследуются от `process.env`, когда сам
    // бенчмарк вызван из-под `node --test` (например этим же тестом): дочерний узел видит
    // себя «внутри уже идущего прогона» и молча пропускает файл вместо запуска — вывод
    // пуст, будто тестов не было ни одного. Гасим обе, дочерний прогон обязан быть
    // независимым от того, кто его вызвал.
    const { NODE_TEST_CONTEXT: _ctx, NODE_TEST_WORKER_ID: _worker, ...cleanEnv } = process.env;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', args.hiddenFile], {
      env: { ...cleanEnv, BENCH_TARGET_DIR: args.targetDir },
      windowsHide: true,
    });

    const out: string[] = [];
    const err: string[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => err.push(d.toString('utf8')));

    const timer =
      args.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            child.kill();
          }, args.timeoutMs);

    child.on('close', () => {
      if (timer !== null) clearTimeout(timer);
      const stdout = out.join('');
      const cases = parseTap(stdout);
      if (cases.length === 0) {
        resolve({
          total: 0,
          pass: 0,
          fail: 0,
          cases: [],
          errorText: `скрытые тесты не дали ни одной разобранной строки TAP — stderr: ${err.join('').slice(0, 2000)}`,
        });
        return;
      }
      const pass = cases.filter((c) => c.ok).length;
      resolve({ total: cases.length, pass, fail: cases.length - pass, cases, errorText: null });
    });

    child.on('error', (e) => {
      if (timer !== null) clearTimeout(timer);
      resolve({ total: 0, pass: 0, fail: 0, cases: [], errorText: e.message });
    });
  });
}
