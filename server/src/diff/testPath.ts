/**
 * Тестовый ли путь — тем же правилом, что `sdlc_common.is_test_path` методологии: каталоги
 * `test/tests/spec/__tests__`, файлы `test_*.py`, `*_test.go`, `*.test.ts`/`*.spec.js`,
 * `tests.py`, `FooTest.java`/`FooTests.kt`. Нужен там, где раннер обязан сойтись с
 * терминальным инструментом (`base-check.py`: тестовые hunk'и патча на базе).
 *
 * `TEST_FILE` в `gates/builtin/logic.ts` — правило гейтов анти-обхода и дублей; оно уже,
 * и менять его семантику ради базы значило бы перекрасить старые гейты.
 */

const TEST_PATH =
  /(^|\/)(tests?|spec|__tests__)(\/|$)|(^|\/)test_[^/]*$|(^|\/)[^/]*_test\.[^/.]+$|(^|\/)[^/]*\.(test|spec)\.[^/]+$|(^|\/)tests?\.py$|(^|\/)[A-Za-z0-9]*Tests?\.(java|kt|cs|scala)$/i;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path.replace(/\\/g, '/'));
}

/** Только файлы патча, чей путь тестовый, — hunk'и остальных выбрасываются целиком. */
export function testOnlyPatch(patch: string): string {
  const out: string[] = [];
  let keep = false;
  for (const ln of patch.split(/(?<=\n)/)) {
    if (ln.startsWith('diff --git ')) {
      const m = /^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+)"|b\/(.+))$/.exec(ln.replace(/\r?\n$/, ''));
      const target = m === null ? '' : (m[3] ?? m[4] ?? '');
      keep = isTestPath(target);
    }
    if (keep) out.push(ln);
  }
  return out.join('');
}
