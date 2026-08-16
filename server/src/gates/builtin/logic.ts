/**
 * Чистая логика встроенных гейтов — порт из `config/agent-sdlc.yaml` платформы
 * AI-Workflow (блоки `build_gate`, `test_gate`, `scope_gate`, `invariant_gate`,
 * `publish_gate`). Там это shell, здесь TypeScript: каждая из этих проверок была
 * выстрадана на живых прогонах, и повторять их отладку в шелле на Windows смысла нет,
 * а покрыть тестами — есть.
 *
 * Здесь нет ни файловой системы, ни git — только правило. I/O живёт в `index.ts`.
 */

export type BuildSystem = {
  /** Команда сборки относительно каталога модуля. */
  build: string;
  /** Команда прогона тестов. `null` — раннера у этой системы нет. */
  test: string | null;
  /** Нужны ли установленные зависимости, чтобы команда вообще имела смысл. */
  needsNodeModules: boolean;
};

/**
 * Детект build-системы по составу каталога.
 *
 * `package.json` идёт ПЕРЕД `tsconfig.json`: собственный build-скрипт проекта — то, чем
 * он реально собирается (esbuild/vite/webpack), тогда как `npx tsc --noEmit` тянет tsc
 * из сети и падает, если его нет локально. tsc остаётся запасным вариантом для проектов
 * с tsconfig, но без build-скрипта.
 */
export function detectBuildSystem(
  files: ReadonlySet<string>,
  packageJson: string | null,
): BuildSystem | null {
  const has = (f: string): boolean => files.has(f);

  if (has('gradlew')) {
    return {
      build: 'sh ./gradlew compileJava compileTestJava --console=plain -q',
      test: 'sh ./gradlew test --console=plain -q',
      needsNodeModules: false,
    };
  }
  if (has('build.gradle') || has('build.gradle.kts')) {
    return {
      build: 'gradle compileJava compileTestJava --console=plain -q',
      test: 'gradle test --console=plain -q',
      needsNodeModules: false,
    };
  }
  if (has('pom.xml')) {
    return { build: 'mvn -q -B test-compile', test: 'mvn -q -B test', needsNodeModules: false };
  }
  if (has('go.mod')) {
    return { build: 'go build ./...', test: 'go test ./...', needsNodeModules: false };
  }
  if (has('Cargo.toml')) {
    return { build: 'cargo check --all-targets', test: 'cargo test', needsNodeModules: false };
  }
  if (has('package.json')) {
    const scripts = packageJson ?? '';
    const hasBuild = /"build"\s*:/.test(scripts);
    const hasTest = /"test"\s*:/.test(scripts);
    if (hasBuild || hasTest || has('tsconfig.json')) {
      return {
        build: hasBuild
          ? 'npm run build'
          : has('tsconfig.json')
            ? 'npx --no-install tsc --noEmit'
            : 'npm run build --if-present',
        test: hasTest ? 'npm test --silent' : null,
        needsNodeModules: true,
      };
    }
    return { build: 'npm run build --if-present', test: null, needsNodeModules: true };
  }
  if (has('tsconfig.json')) {
    return { build: 'npx --no-install tsc --noEmit', test: null, needsNodeModules: true };
  }
  if (has('pyproject.toml') || has('setup.py') || has('pytest.ini') || has('setup.cfg')) {
    return {
      build: 'python3 -m compileall -q .',
      test: 'python3 -m pytest -q',
      needsNodeModules: false,
    };
  }
  return null;
}

/**
 * Каталог сборки выводится ИЗ ПЛАНА, а не перебором подкаталогов по алфавиту.
 *
 * В моно-репо алфавит выбирает случайный модуль: на живом прогоне гейт брал `frontend/`,
 * тогда как правки шли в `vscode-extension/` — и зеленел, не проверив ничего по существу.
 * Идём от первого файла плана вверх до первого каталога с манифестом.
 */
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
): ScopeViolation[] {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
  const allow = new Set(allowed.map(norm));
  const allowBase = new Set([...allow].map(basename));

  const out: ScopeViolation[] = [];
  for (const raw of changed) {
    const f = norm(raw);
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

const CODE_EXT =
  /\.(java|kt|kts|scala|groovy|ts|tsx|js|jsx|py|go|cs|rb|rs|php|swift)$/i;

/**
 * Проверки применяются только к некомментарным добавленным строкам: без этого гейт
 * срабатывает на собственных правилах, процитированных в комментариях и документации,
 * и превращается в шум (проверено на живом diff).
 */
const COMMENT = /^\+\s*(\/\/|#|\*|--|\/\*)/;

const DISABLE_MARKERS =
  /@Disabled|@Ignore|@pytest\.mark\.skip|\bit\.skip\(|\bdescribe\.skip\(|\bxit\(|\bxdescribe\(|\btest\.skip\(|\.only\(|t\.Skip\(|#\[ignore\]|@unittest\.skip/;

const TEST_DECL = /@Test|def test_|func Test|\bit\(|\btest\(|\[Fact\]|\[Test\]/;

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
  const code = all.filter((l) => CODE_EXT.test(l.file));
  const addedCode = code.filter((l) => l.added && !COMMENT.test(l.text));

  const disabled = addedCode.filter((l) => DISABLE_MARKERS.test(l.text));
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
  const added = addedCode.filter((l) => TEST_DECL.test(l.text)).length;
  const removed = code.filter(
    (l) => !l.added && !l.text.startsWith('--') && TEST_DECL.test(l.text),
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
