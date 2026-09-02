/**
 * Реестр задач бенчмарка.
 *
 * Существование файлов проверяется для каждой задачи, чей каталог фикстуры лежит на диске:
 * каталог есть — семейство заявлено построенным, и все четыре файла задачи обязаны быть.
 * Задача без каталога — ещё в роадмапе, её файлы не требуются: иначе реестр был бы
 * нерасширяем без готового контента — ровно то, от чего он и заведён.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ok, strictEqual, throws } from 'node:assert/strict';

import { TASKS } from '../src/options.ts';
import { TASK_DEFS, TaskError, taskById, taskPaths } from '../src/tasks.ts';

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
      // Пути — из taskPaths(), тех же, что берёт CLI: тест по своей копии правила зеленел бы
      // там, где CLI ищет файл в другом месте.
      const p = taskPaths(BENCH_DIR, def);
      for (const f of [p.taskFile, p.humanFile, p.expectedFile, p.hiddenFile]) {
        ok(existsSync(f), `${def.id}: нет ${f}`);
      }
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
