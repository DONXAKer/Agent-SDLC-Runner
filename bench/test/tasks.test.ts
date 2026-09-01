/**
 * Реестр задач бенчмарка.
 *
 * Существование файлов проверяется ТОЛЬКО для задач общей фикстуры `fixture`: каталоги
 * `fixtures/<family>` заводятся постепенно, другими шагами роадмапа, и требовать их здесь
 * значило бы сделать реестр нерасширяемым без готового контента — ровно то, от чего реестр
 * и заведён.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ok, strictEqual, throws } from 'node:assert/strict';

import { TASKS } from '../src/options.ts';
import { TASK_DEFS, TaskError, taskById } from '../src/tasks.ts';

const BENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('реестр задач', () => {
  it('идентификаторы уникальны', () => {
    const ids = TASK_DEFS.map((t) => t.id);
    strictEqual(new Set(ids).size, ids.length);
  });

  it('список задач разбора аргументов выводится из реестра, а не дублирует его', () => {
    strictEqual(TASKS.join(','), TASK_DEFS.map((t) => t.id).join(','));
  });

  it('taskById возвращает запись, неизвестный id отвергается со списком допустимых', () => {
    strictEqual(taskById('oversize').fixtureDir, 'fixture');
    throws(() => taskById('нет-такой'), TaskError);
    throws(() => taskById('нет-такой'), /допустимы: oversize, freeship/);
  });

  it('у каждой задачи с каталогом фикстуры на диске лежат все четыре файла', () => {
    // Каталог семейства есть — значит, задача заявлена готовой, и опечатка в реестре
    // (не тот id, не то семейство) обязана всплыть здесь, а не ENOENT'ом на платном прогоне.
    // Каталога нет — задача ещё в роадмапе, её файлы не требуются (см. шапку файла).
    const present = TASK_DEFS.filter((t) => existsSync(join(BENCH_DIR, t.fixtureDir)));
    ok(present.length >= 2, 'общая фикстура обязана нести минимум oversize и freeship');
    for (const def of present) {
      ok(existsSync(join(BENCH_DIR, def.fixtureDir, def.taskFile)), `${def.id}: ${def.taskFile}`);
      ok(existsSync(join(BENCH_DIR, def.fixtureDir, def.humanFile)), `${def.id}: ${def.humanFile}`);
      ok(existsSync(join(BENCH_DIR, 'expected', `${def.id}.json`)), `${def.id}: expected/${def.id}.json`);
      ok(existsSync(join(BENCH_DIR, 'checks', 'hidden', `${def.id}.hidden.mjs`)), `${def.id}: checks/hidden/${def.id}.hidden.mjs`);
    }
  });

  it('задачи `fixtures/<family>` несут имена файлов, выведенные из id', () => {
    // Существование НЕ проверяем: каталоги появятся позже. Проверяется лишь форма записи —
    // она едина для всех семейств, и разнобой здесь означал бы опечатку в реестре.
    for (const def of TASK_DEFS.filter((t) => t.fixtureDir !== 'fixture')) {
      strictEqual(def.taskFile, `task-${def.id}.md`, def.id);
      strictEqual(def.humanFile, `human-${def.id}.json`, def.id);
      ok(def.fixtureDir.startsWith('fixtures/'), def.id);
    }
  });
});
