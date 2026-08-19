/**
 * Чистая логика встроенных гейтов — порт из `config/agent-sdlc.yaml` платформы
 * AI-Workflow (блоки `build_gate`, `test_gate`, `scope_gate`, `invariant_gate`,
 * `publish_gate`). Там это shell, здесь TypeScript: каждая из этих проверок была
 * выстрадана на живых прогонах, и повторять их отладку в шелле на Windows смысла нет,
 * а покрыть тестами — есть.
 *
 * Здесь нет ни файловой системы, ни git — только правило. I/O живёт в `index.ts`.
 */

import { normalizePlanPath } from '../../policy/paths.ts';
// Знание о языках живёт в реестре экосистем: добавление языка не должно требовать правки
// этого файла. Здесь остаются только правила, одинаковые для всех языков.
import {
  CODE_EXTENSIONS,
  DISABLE_MARKERS,
  TEST_DECLARATIONS,
} from '../ecosystems/index.ts';

/**
 * Каталог сборки выводится ИЗ ПЛАНА, а не перебором подкаталогов по алфавиту.
 *
 * В моно-репо алфавит выбирает случайный модуль: на живом прогоне гейт брал `frontend/`,
 * тогда как правки шли в `vscode-extension/` — и зеленел, не проверив ничего по существу.
 * Идём от первого файла плана вверх до первого каталога с манифестом.
 */
/**
 * Единая форма пути модуля: без ведущего `./`, без хвостового слэша, корень — `.`.
 *
 * Нужна и конфигу, и детекту: сравнивать «путь из JSON, написанный человеком» с «путь,
 * выведенный из плана» по сырой строке значит промахиваться на `./web` против `web`.
 */
export function normalizeModuleDir(dir: string): string {
  const trimmed = dir.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.' ? '.' : trimmed;
}

/**
 * ВСЕ каталоги-модули, затронутые планом, в порядке первого появления.
 *
 * `moduleDirFromPlan` возвращал первый и на этом останавливался — в моно-репо это ложный
 * зелёный по построению: план трогает `server/` и `web/`, гейт собирает `server/`, а
 * отчёт этапа 6 пишет «Сборка ✅». Прошлое лечение (замена алфавитного перебора на первый
 * модуль плана) было правильным, но неполным: случайный модуль заменили на первый, а не на
 * все затронутые.
 */
export function moduleDirsFromPlan(
  planFiles: readonly string[],
  isModule: (dir: string) => boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string): void => {
    if (seen.has(dir)) return;
    seen.add(dir);
    out.push(dir);
  };

  for (const file of planFiles) {
    let dir = parentOf(file);
    while (dir !== null) {
      if (isModule(dir)) {
        add(dir);
        break;
      }
      dir = parentOf(dir);
    }
  }

  // Корень — запасной вариант, и только когда не нашлось ни одного модуля: иначе он
  // добавлялся бы к каждому моно-репо вторым «модулем» и собирал бы всё дважды.
  if (out.length === 0 && isModule('.')) add('.');
  return out;
}

export function moduleDirFromPlan(
  planFiles: readonly string[],
  isModule: (dir: string) => boolean,
): string | null {
  for (const file of planFiles) {
    let dir = parentOf(file);
    while (dir !== null) {
      if (isModule(dir)) return dir;
      dir = parentOf(dir);
    }
  }
  return isModule('.') ? '.' : null;
}

/**
 * Родительский каталог, `null` — выше корня проекта.
 *
 * Корень обязан завершать подъём: пока `parentOf('.')` возвращал `'.'`, цикл поиска
 * модуля крутился вечно на любом плане, для которого манифест не нашёлся.
 */
function parentOf(p: string): string | null {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm === '' || norm === '.') return null;
  const i = norm.lastIndexOf('/');
  if (i < 0) return '.';
  const parent = norm.slice(0, i);
  return parent === '' ? null : parent;
}

// ---------------------------------------------------------------------------
// Scope: файлы вне плана
// ---------------------------------------------------------------------------

export interface ScopeViolation {
  path: string;
  /** Совпало имя файла, но не каталог — почти всегда промах модулем, а не новый файл. */
  sameName: boolean;
}

const basename = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? p;

/**
 * Пути `.sdlc/**` из сверки исключены — так сказано в самой строке набора: артефакты
 * витка меняются на каждом этапе по построению, и вменять их как scope creep значит
 * держать гейт вечно красным.
 */
export function scopeViolations(
  changed: readonly string[],
  allowed: readonly string[],
  projectRoot: string,
): ScopeViolation[] {
  // Нормализация — та же, что у PlanScope (`normalizePlanPath`), а не своя.
  // Пока здесь стоял собственный `norm` (только слэши и `./`), план с абсолютным путём
  // `D:/proj/src/a.ts` — а модели пишут такие регулярно, ради этого `normalizePlanPath`
  // и написан — давал расхождение: PlanScope запись разрешал, а scope-гейт печатал
  // «файл вне files_to_touch» на файле, который рантайм сам и разрешил править.
  const allow = new Set(allowed.map((p) => normalizePlanPath(projectRoot, p)));
  const allowBase = new Set([...allow].map(basename));

  const out: ScopeViolation[] = [];
  for (const raw of changed) {
    const f = normalizePlanPath(projectRoot, raw);
    if (f.startsWith('.sdlc/')) continue;
    if (allow.has(f)) continue;
    out.push({ path: f, sameName: allowBase.has(basename(f)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Анти-обход тест-гейта и секреты в diff
// ---------------------------------------------------------------------------

export interface InvariantViolation {
  kind: 'test-disabled' | 'test-file-deleted' | 'tests-removed' | 'secret-in-diff';
  detail: string;
}

/**
 * Расширение исходника проверяется по реестру, а не регуляркой: `\b` в JS не работает по
 * кириллице, а закрытый список расширений в этом файле был четвёртым местом, куда надо
 * было не забыть дописать новый язык.
 */
function isCode(file: string): boolean {
  const dot = file.lastIndexOf('.');
  return dot >= 0 && CODE_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

/**
 * Проверки применяются только к некомментарным добавленным строкам: без этого гейт
 * срабатывает на собственных правилах, процитированных в комментариях и документации,
 * и превращается в шум (проверено на живом diff).
 */
const COMMENT = /^\+\s*(\/\/|#|\*|--|\/\*)/;

/**
 * Маркеры сравниваются подстрокой, а не регуляркой: они приходят из реестра как данные,
 * и собирать из них регулярку значило бы экранировать `[`, `(` и `.` в каждой строке
 * реестра — ровно тот класс ошибок, из-за которого вся обязательная пятёрка однажды молча
 * числилась выключенной.
 */
function hasAny(text: string, needles: readonly string[]): boolean {
  return needles.some((n) => text.includes(n));
}

const TEST_FILE =
  /(^|\/)(test|tests|spec)\/|[._-](test|spec)s?\.[a-z]+$|Tests?\.(java|kt|cs)$/i;

const SECRET =
  /BEGIN [A-Z ]*PRIVATE KEY|(api[_-]?key|apikey|secret|password|passwd|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9/+_.=-]{16,}/i;

interface DiffLine {
  file: string;
  text: string;
  added: boolean;
}

/** Разбор unified diff в строки с именем файла — только то, что нужно проверкам. */
export function diffLines(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let file = '';
  for (const line of diff.split(/\r?\n/)) {
    const m = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (m !== null) {
      file = m[1]!.trim();
      continue;
    }
    if (/^(---|diff |index |@@|new file|deleted file|similarity|rename)/.test(line)) continue;
    if (line.startsWith('+')) out.push({ file, text: line, added: true });
    else if (line.startsWith('-')) out.push({ file, text: line, added: false });
  }
  return out;
}

export function invariantViolations(
  diff: string,
  deletedFiles: readonly string[],
): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  const all = diffLines(diff);
  const code = all.filter((l) => isCode(l.file));
  const addedCode = code.filter((l) => l.added && !COMMENT.test(l.text));

  const disabled = addedCode.filter((l) => hasAny(l.text, DISABLE_MARKERS));
  if (disabled.length > 0) {
    out.push({
      kind: 'test-disabled',
      detail:
        'в diff добавлено отключение или фокусировка тестов — тесты нельзя глушить ради ' +
        `зелёного прогона:\n${disabled.map((l) => `  ${l.file}: ${l.text.trim()}`).join('\n')}`,
    });
  }

  const deletedTests = deletedFiles.filter((f) => TEST_FILE.test(f));
  if (deletedTests.length > 0) {
    out.push({
      kind: 'test-file-deleted',
      detail: `удалены тестовые файлы:\n${deletedTests.map((f) => `  ${f}`).join('\n')}`,
    });
  }

  // Нетто-убыль деклараций: тесты не починили, а выкинули. Считаем только по коду и
  // только по некомментарным строкам — иначе закомментированный пример роняет гейт.
  const added = addedCode.filter((l) => hasAny(l.text, TEST_DECLARATIONS)).length;
  const removed = code.filter(
    (l) => !l.added && !l.text.startsWith('--') && hasAny(l.text, TEST_DECLARATIONS),
  ).length;
  if (removed > added) {
    out.push({
      kind: 'tests-removed',
      detail:
        `тестовых деклараций удалено (${removed}) больше, чем добавлено (${added}) — ` +
        `падающие тесты выкинуты, а не починены`,
    });
  }

  // Секреты ищем по всему diff'у, не только по коду: `.env.example`, конфиг, workflow —
  // при публикации это одинаково необратимо.
  const secrets = all.filter((l) => l.added && !COMMENT.test(l.text) && SECRET.test(l.text));
  if (secrets.length > 0) {
    out.push({
      kind: 'secret-in-diff',
      detail:
        'в diff похоже на захардкоженный секрет:\n' +
        secrets.map((l) => `  ${l.file}: ${l.text.trim().slice(0, 120)}`).join('\n'),
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Предусловия публикации
// ---------------------------------------------------------------------------

const PROTECTED_BRANCH = /^(main|master|develop|trunk|HEAD)$/;

const JUNK =
  /(^|\/)(build|target|dist|out|node_modules|\.gradle|\.idea|__pycache__|coverage)\/|\.(class|jar|log)$|(^|\/)\.env/;

export function publishProblems(i: {
  branch: string;
  /** `null` — вышестоящей ветки нет, сравнивать не с чем. */
  commitsAhead: number | null;
  committedFiles: readonly string[];
}): string[] {
  const out: string[] = [];
  if (PROTECTED_BRANCH.test(i.branch)) {
    out.push(
      `[protected-branch] HEAD на «${i.branch}» — этап 7 не создал ветку задачи, публикация ` +
        `ушла бы прямо в основную ветку`,
    );
  }
  if (i.commitsAhead === 0) {
    out.push('[nothing-to-publish] нет локальных коммитов впереди origin — коммит ничего не зафиксировал');
  }
  const junk = i.committedFiles.filter((f) => JUNK.test(f.replace(/\\/g, '/')));
  if (junk.length > 0) {
    out.push(
      `[build-artifacts-committed] в коммите артефакты сборки или локальные файлы ` +
        `(следствие «git add -A»):\n${junk.map((f) => `  ${f}`).join('\n')}`,
    );
  }
  return out;
}
