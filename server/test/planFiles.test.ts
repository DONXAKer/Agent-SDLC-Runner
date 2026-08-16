import { deepStrictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { extractFilesToTouch } from '../src/artifacts/planFiles.ts';
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

  it('живой пример методологии разбирается целиком', () => {
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
