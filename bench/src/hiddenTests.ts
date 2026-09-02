/**
 * Запуск скрытых тестов (шаг 5/7 ROADMAP.md) дочерним процессом.
 *
 * Тонкая обвязка ввода-вывода вокруг чистых `bench/checks/hidden/*.hidden.mjs`: сама
 * функция ничего не решает, только спрашивает `node --test` и разбирает TAP-вывод.
 * Держится отдельно от `report.ts`, чтобы форматирование отчёта проверялось без единого
 * дочернего процесса.
 */

import { spawnNodeTest } from './nodeTest.ts';

export interface HiddenCaseResult {
  id: string;
  category: string;
  ok: boolean;
  /**
   * Кейс не исполнялся по решению самого теста: `t.skip()` → `ok N - … # SKIP`, `t.todo()`
   * → `ok|not ok N - … # TODO`. TAP пишет пропущенный кейс как `ok`, и до этого поля он
   * засчитывался зелёным: кейсы «дерево не тронуто» (`skipUnlessGit` в раннерах семейств)
   * на цели без `.git` красили бы щуп точности правки в зелёный ровно там, где проверки не
   * было. Пропущенное — не в числителе и не в знаменателе.
   */
  skipped: boolean;
  label: string;
}

export interface HiddenTestsSummary {
  /** Без пропущенных: `pass + fail`. */
  total: number;
  pass: number;
  fail: number;
  skipped: number;
  cases: HiddenCaseResult[];
  /** Пусто, если процесс завершился нормально (упавшие тесты — это `cases`, не это поле). */
  errorText: string | null;
}

/** `ok 3 - H1 [human] (claim-5): текст` / `ok 4 - Pr2 [precision] (claim-3): текст # SKIP причина`. */
const TAP_LINE_RE = /^(ok|not ok)\s+\d+\s+-\s+(\S+)\s+\[(\w+)\](.*)$/u;
/** Директивы TAP: `# SKIP` всегда идёт с `ok`, `# TODO` — с любым исходом; обе означают «не считать». */
const TAP_SKIP_RE = /#\s*(SKIP|TODO)\b/iu;

function parseTap(stdout: string): HiddenCaseResult[] {
  const cases: HiddenCaseResult[] = [];
  for (const line of stdout.split('\n')) {
    const m = TAP_LINE_RE.exec(line.trim());
    if (m === null) continue;
    const skipped = TAP_SKIP_RE.test(m[4] ?? '');
    cases.push({ ok: m[1] === 'ok' && !skipped, skipped, id: m[2]!, category: m[3]!, label: line.trim() });
  }
  return cases;
}

export function summarize(cases: HiddenCaseResult[]): Omit<HiddenTestsSummary, 'errorText'> {
  const counted = cases.filter((c) => !c.skipped);
  const pass = counted.filter((c) => c.ok).length;
  return { total: counted.length, pass, fail: counted.length - pass, skipped: cases.length - counted.length, cases };
}

/**
 * Запускает один файл скрытых тестов против целевого дерева (`BENCH_TARGET_DIR` — путь,
 * где лежит `src/`, обычно копия рабочей копии витка ПОСЛЕ chunk'а, снятая на одноразовой
 * копии — см. комментарий в самом `.hidden.mjs`).
 */
export async function runHiddenTests(args: { hiddenFile: string; targetDir: string; timeoutMs?: number }): Promise<HiddenTestsSummary> {
  // `--test-reporter=tap` (внутри spawnNodeTest): репортёр по умолчанию (`spec`) не даёт
  // машиночитаемых строк «ok N - имя» — только символы ✔/✖ для терминала. TAP — единственный
  // штатный формат, который парсится регуляркой, а не угадыванием по эмодзи.
  const out = await spawnNodeTest({
    testArgs: [args.hiddenFile],
    env: { BENCH_TARGET_DIR: args.targetDir },
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  });
  const cases = parseTap(out.stdout);
  if (cases.length === 0) {
    // Причина краха до единого кейса (битый импорт цели) приходит от `node --test` в STDOUT
    // строками-комментариями `# …`, stderr при этом пуст — «stderr: » в отчёте ничего не
    // объяснял. Берём и то и другое.
    const comments = out.stdout
      .split('\n')
      .filter((l) => l.startsWith('#') && !/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /u.test(l))
      .join('\n');
    const why = [out.timedOut ? `снято по таймауту ${args.timeoutMs} мс` : '', out.stderr.trim(), comments.trim()]
      .filter((s) => s !== '')
      .join('\n')
      .slice(0, 2000);
    return {
      total: 0,
      pass: 0,
      fail: 0,
      skipped: 0,
      cases: [],
      errorText: `скрытые тесты не дали ни одной разобранной строки TAP — ${why === '' ? 'вывод пуст' : why}`,
    };
  }
  return { ...summarize(cases), errorText: null };
}
