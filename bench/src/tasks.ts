/**
 * Реестр задач бенчмарка.
 *
 * Зачем реестр, а не соглашение об именах. До многозадачности пути `task*.md`/`human*.json`
 * выводились в `cli.ts` из имени задачи — с особым случаем для `oversize`, заведённой раньше
 * всех. С появлением нескольких каталогов фикстур (`fixtures/<family>`) соглашение перестало
 * выводиться из одного имени: задача обязана назвать и каталог, и оба файла. Явная запись на
 * задачу читается и проверяется тестом, а не зашита в ветвление.
 *
 * Каталоги `fixtures/*` на диске появляются постепенно, другими задачами роадмапа — реестр
 * описывает план целиком, а существование файлов проверяется тестом только для тех задач,
 * чья фикстура уже лежит в репозитории (`fixture`).
 */

export class TaskError extends Error {}

export interface TaskDef {
  id: string;
  /** Каталог фикстуры относительно bench/: `fixture` либо `fixtures/<family>`. */
  fixtureDir: string;
  /** Имя файла задачи внутри каталога фикстуры. */
  taskFile: string;
  /** Имя банка ответов человека внутри каталога фикстуры. */
  humanFile: string;
}

/** Записи `fixtures/<family>`: taskFile/humanFile выводятся из id — одна форма на всех. */
function familyTask(id: string, family: string): TaskDef {
  return { id, fixtureDir: `fixtures/${family}`, taskFile: `task-${id}.md`, humanFile: `human-${id}.json` };
}

export const TASK_DEFS: readonly TaskDef[] = [
  // `oversize` — первая задача, заведена до многозадачности: имена файлов без суффикса
  // по историческим причинам, менять их значило бы трогать эталон и снимки.
  { id: 'oversize', fixtureDir: 'fixture', taskFile: 'task.md', humanFile: 'human.json' },
  { id: 'freeship', fixtureDir: 'fixture', taskFile: 'task-freeship.md', humanFile: 'human-freeship.json' },

  familyTask('vat-rounding', 'billing'),
  familyTask('add-validator', 'billing'),
  familyTask('config-default', 'billing'),
  familyTask('silent-contract', 'billing'),

  familyTask('perf-keep-behavior', 'ledger'),
  familyTask('contradiction', 'ledger'),
  familyTask('refuse-dangerous', 'ledger'),
  familyTask('multi-file-cascade', 'ledger'),
  familyTask('zero-change-verify', 'ledger'),

  familyTask('cli-flag', 'cli-tool'),
  familyTask('scope-bait', 'cli-tool'),
  familyTask('plan-only-trap', 'cli-tool'),

  familyTask('tz-deadline', 'booking'),
  familyTask('two-right-answers', 'booking'),

  familyTask('idempotent-retry', 'notify'),
  familyTask('security-bait', 'notify'),
  familyTask('silent-partial', 'notify'),

  familyTask('rename-field', 'catalog'),
  familyTask('migration-compat', 'catalog'),

  familyTask('impossible-without-data', 'warehouse'),
  familyTask('ghost-requirement', 'warehouse'),

  familyTask('docs-sync', 'legacy-docs'),
  familyTask('characterization', 'legacy-docs'),

  familyTask('external-contract', 'payments-mock'),

  familyTask('already-done', 'feature-present'),
  familyTask('undo-feature', 'feature-present'),

  familyTask('broken-test', 'broken-assert'),

  familyTask('flaky-by-design', 'flaky-test'),

  familyTask('bug-by-symptom', 'billing-bug'),
  familyTask('wrong-diagnosis', 'billing-bug'),
];

export function taskById(id: string): TaskDef {
  const t = TASK_DEFS.find((x) => x.id === id);
  if (t === undefined) {
    throw new TaskError(`неизвестная задача «${id}»; допустимы: ${TASK_DEFS.map((x) => x.id).join(', ')}`);
  }
  return t;
}
