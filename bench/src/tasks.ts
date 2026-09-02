/**
 * Реестр задач бенчмарка.
 *
 * Зачем реестр, а не соглашение об именах. До многозадачности пути `task*.md`/`human*.json`
 * выводились в `cli.ts` из имени задачи — с особым случаем для `oversize`, заведённой раньше
 * всех. С появлением нескольких каталогов фикстур (`fixtures/<family>`) соглашение перестало
 * выводиться из одного имени: задача обязана назвать и каталог, и оба файла. Явная запись на
 * задачу читается и проверяется тестом, а не зашита в ветвление.
 *
 * Каталоги `fixtures/*` на диске появляются постепенно, семействами — реестр описывает план
 * целиком. Для задачи, чей каталог уже лежит в репозитории, `tasks.test.ts` требует все
 * четыре файла (`taskPaths`); для задачи без каталога `--task` отвечает кодом 2 и причиной.
 */

import { join } from 'node:path';

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

/**
 * Записи `fixtures/<family>`: taskFile/humanFile выводятся из id — одна форма на всех.
 * `const I` сохраняет литерал id в типе: из реестра выводится union `TaskId`, и опечатка в
 * `--task`-умолчании или в тесте ловится компилятором, а не платным прогоном.
 */
function familyTask<const I extends string>(id: I, family: string): TaskDef & { id: I } {
  return { id, fixtureDir: `fixtures/${family}`, taskFile: `task-${id}.md`, humanFile: `human-${id}.json` };
}

export const TASK_DEFS = [
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
] as const satisfies readonly TaskDef[];

/** Литеральный union id задач — выводится из реестра, а не переписывается рядом с ним. */
export type TaskId = (typeof TASK_DEFS)[number]['id'];

export function isTaskId(v: string): v is TaskId {
  return TASK_DEFS.some((t) => t.id === v);
}

export function taskById(id: string): TaskDef {
  const t = TASK_DEFS.find((x) => x.id === id);
  if (t === undefined) {
    throw new TaskError(`неизвестная задача «${id}»; допустимы: ${TASK_DEFS.map((x) => x.id).join(', ')}`);
  }
  return t;
}

export interface TaskPaths {
  fixtureDir: string;
  taskFile: string;
  humanFile: string;
  expectedFile: string;
  hiddenFile: string;
}

/**
 * Все пути задачи — одно место (как `artifacts/paths.ts` у раннера). Раньше эталон и скрытый
 * тест собирались строкой отдельно в CLI и отдельно в тесте реестра: тест зеленел по своей
 * копии правила, а CLI при опечатке в имени `<id>.hidden.mjs` молча писал «скрытые тесты не
 * запускались» после платного прогона.
 */
export function taskPaths(benchDir: string, def: TaskDef): TaskPaths {
  const fixtureDir = join(benchDir, def.fixtureDir);
  return {
    fixtureDir,
    taskFile: join(fixtureDir, def.taskFile),
    humanFile: join(fixtureDir, def.humanFile),
    expectedFile: join(benchDir, 'expected', `${def.id}.json`),
    hiddenFile: join(benchDir, 'checks', 'hidden', `${def.id}.hidden.mjs`),
  };
}
