import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFileSync, existsSync} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
/**
 * Эталон методологии — чужой каталог на машине оператора (`methodologyDir`/`skillsDir` из
 * конфига), и на другой машине его просто нет. Такие кейсы ПРОПУСКАЮТСЯ с названной
 * причиной, а не остаются вечно красными: набор, красный по умолчанию, приучает себя
 * игнорировать, и настоящая регрессия в нём не видна. Там, где эталон есть, они работают
 * как раньше. Герметичный двойник для сборки промпта — `promptEcosystem.test.ts`.
 */
function нетЭталона(dir: string): string | false {
  return existsSync(dir) ? false : `нет эталона методологии на этой машине: ${dir}`;
}


import { appendScopeExtension, extractFilesToTouch } from '../src/artifacts/planFiles.ts';
import { loadConfig } from '../src/config/load.ts';

describe('files_to_touch', () => {
  it('читает пути из таблицы плана', () => {
    const plan = [
      '## files_to_touch',
      '',
      '| Путь | Что делаем |',
      '|---|---|',
      '| `src/a.java` | обёртка |',
      '| `src/b.java` | заголовок |',
      '',
      '## Чем закрывается',
      '| `src/never.java` | эта секция уже не про allowlist |',
    ].join('\n');
    deepStrictEqual(extractFilesToTouch(plan), ['src/a.java', 'src/b.java']);
  });

  it('не тащит в allowlist пути из «Из задачи исключено»', () => {
    // Расширить allowlist этими путями значило бы разрешить правку в файле, который
    // трогать не собирались, — методология это запрещает прямым текстом.
    const plan = [
      '## files_to_touch',
      '| Путь | Что делаем |',
      '|---|---|',
      '| `src/a.java` | правим |',
      '',
      '- **Добавлено сверх разведки:** `src/extra.java` — понадобился под claim-3',
      '- **Из задачи исключено:** `src/skipped.java` — не понадобился',
      '',
      '## Дальше',
    ].join('\n');
    const files = extractFilesToTouch(plan);
    deepStrictEqual(files, ['src/a.java', 'src/extra.java']);
  });

  it('пустой план даёт пустой список — PlanScope тогда выключен', () => {
    deepStrictEqual(extractFilesToTouch('# План\nбез секции'), []);
  });

  it('плейсхолдеры формы путями не считаются', () => {
    const plan = '## files_to_touch\n| Путь | Что делаем |\n|---|---|\n| ‹path/to/file› | ‹что делаем› |\n';
    deepStrictEqual(extractFilesToTouch(plan), []);
  });

  it('артефакты процесса в allowlist не попадают', () => {
    const plan = '## files_to_touch\n| `.sdlc/demo/plan.md` | нет |\n| `src/a.ts` | да |\n';
    deepStrictEqual(extractFilesToTouch(plan), ['src/a.ts']);
  });

  it('проза без обратных кавычек не становится путём', () => {
    const plan = '## files_to_touch\n\nсписок совпал с разведкой, менять нечего\n';
    deepStrictEqual(extractFilesToTouch(plan), []);
  });

  it('appendScopeExtension дописывает путь после «Добавлено сверх разведки»', () => {
    const plan = [
      '## files_to_touch',
      '| Путь | Что делаем |',
      '|---|---|',
      '| `src/a.java` | правим |',
      '',
      '- **Добавлено сверх разведки:** нет',
      '- **Из задачи исключено:** нет',
      '',
      '## Дальше',
    ].join('\n');
    const updated = appendScopeExtension(plan, 'src/extra.java', 'расширено на этапе chunk · Иван · 2026-08-23 — понадобился под claim-3');
    ok(updated !== null);
    ok(updated.includes('src/extra.java'));
    // Дописанный путь обязан реально попасть в allowlist — не просто лечь строкой в файл,
    // а быть виден тому же парсеру, который читает files_to_touch для PlanScope.
    deepStrictEqual(extractFilesToTouch(updated), ['src/a.java', 'src/extra.java']);
  });

  it('appendScopeExtension — null, если в plan.md нет строки «Добавлено сверх разведки»', () => {
    const plan = '## files_to_touch\n| `src/a.java` | правим |\n';
    strictEqual(appendScopeExtension(plan, 'src/extra.java', 'причина'), null);
  });

  it('appendScopeExtension — вторая запись встаёт ПОСЛЕ первой, не между маркером и ней', () => {
    // Регресс на LIFO: раньше каждая вставка матчила статичный маркер, а не последнюю уже
    // добавленную строку, и порядок в plan.md получался обратным хронологии одобрений.
    const plan = [
      '## files_to_touch',
      '| `src/a.java` | правим |',
      '',
      '- **Добавлено сверх разведки:** нет',
      '- **Из задачи исключено:** нет',
    ].join('\n');
    const afterFirst = appendScopeExtension(plan, 'src/first.java', 'первая');
    ok(afterFirst !== null);
    const afterSecond = appendScopeExtension(afterFirst, 'src/second.java', 'вторая');
    ok(afterSecond !== null);

    const firstAt = afterSecond.indexOf('src/first.java');
    const secondAt = afterSecond.indexOf('src/second.java');
    ok(firstAt >= 0 && secondAt >= 0);
    ok(firstAt < secondAt, `порядок должен быть хронологическим: first=${firstAt}, second=${secondAt}`);
    deepStrictEqual(extractFilesToTouch(afterSecond), ['src/a.java', 'src/first.java', 'src/second.java']);
  });

  it('артефакт витка, помянутый в прозе секции, путём плана не становится (r21)', () => {
    // Живой план: «**Добавлено сверх разведки:** нет — список совпадает с … из `intent.md`».
    // Упоминание давало ЧЕТВЁРТЫЙ путь: PlanScope выдавал право писать в артефакт человека,
    // а гейт «Scope: пути плана без правок» краснел на пути, который никто не правит, —
    // вердикт не мог позеленеть в принципе.
    const plan = [
      '## files_to_touch',
      '',
      '| Путь | Что делаем |',
      '|---|---|',
      '| `src/a.ts` | правка |',
      '',
      '- **Добавлено сверх разведки:** нет — список совпадает с «Что придётся тронуть» из `intent.md`',
      '- Пункты приёмки перенесены из `readiness.md`, журнал витка — `chunk-1-journal.md`',
      '',
    ].join('\n');
    deepStrictEqual(extractFilesToTouch(plan), ['src/a.ts']);
  });

  it('живой пример методологии разбирается целиком', { skip: нетЭталона(loadConfig().runner.methodologyDir) }, () => {
    const cfg = loadConfig();
    const example = join(cfg.runner.methodologyDir, 'example', 'plan.md');
    const files = extractFilesToTouch(readFileSync(example, 'utf8'));
    deepStrictEqual(files, [
      'src/main/java/com/acme/payments/service/PaymentService.java',
      'src/main/java/com/acme/payments/web/PaymentController.java',
      'src/main/java/com/acme/payments/schedule/PaymentRetryScheduler.java',
      'src/test/java/com/acme/payments/PaymentIdempotencyIT.java',
    ]);
  });
});
