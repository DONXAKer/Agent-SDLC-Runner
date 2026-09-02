/**
 * Рабочая копия фикстуры: что из каталога семейства доезжает до дерева модели.
 *
 * Банк ответов человека несёт секрет вопроса (ставку, порог) — в дереве модели ему не место,
 * иначе Grep по корню отдавал бы ответ без единого вопроса и щуп «вопросы человеку» мерил
 * бы ничего. Поймано ревью обвязки, не живым прогоном.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BENCH_ONLY_FILE, prepareWorkspace } from '../src/workspace.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('prepareWorkspace', () => {
  it('human-*.json и task-*.md семейства в рабочую копию не копируются, остальное — копируется', async () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-bench-fixture-')));
    roots.push(fixture);
    mkdirSync(join(fixture, 'src'));
    mkdirSync(join(fixture, 'docs'));
    writeFileSync(join(fixture, 'src', 'index.ts'), 'export const a = 1;\n', 'utf8');
    writeFileSync(join(fixture, 'README.md'), '# ф\n', 'utf8');
    writeFileSync(join(fixture, 'human.json'), '{"secret":"10%"}\n', 'utf8');
    writeFileSync(join(fixture, 'human-vat-rounding.json'), '{"secret":"10%"}\n', 'utf8');
    writeFileSync(join(fixture, 'task.md'), '`sdlc/x`\n', 'utf8');
    writeFileSync(join(fixture, 'task-vat-rounding.md'), '`sdlc/vat-rounding`\n', 'utf8');
    // Одноимённый файл ГЛУБЖЕ корня — часть проекта, а не бенчмарка: фильтр только по корню.
    writeFileSync(join(fixture, 'docs', 'task.md'), 'документ проекта\n', 'utf8');

    const ws = await prepareWorkspace({ fixtureDir: fixture, slug: 'x', branch: 'sdlc/x' });
    roots.push(ws.root);
    try {
      ok(existsSync(join(ws.root, 'src', 'index.ts')));
      ok(existsSync(join(ws.root, 'README.md')));
      ok(existsSync(join(ws.root, 'docs', 'task.md')), 'task.md внутри проекта — не банк бенчмарка');
      for (const f of ['human.json', 'human-vat-rounding.json', 'task.md', 'task-vat-rounding.md']) {
        strictEqual(existsSync(join(ws.root, f)), false, `${f} утёк в дерево модели`);
      }
    } finally {
      ws.dispose();
    }
  });

  it('BENCH_ONLY_FILE узнаёт файлы бенчмарка и не трогает похожие имена проекта', () => {
    for (const f of ['human.json', 'human-freeship.json', 'task.md', 'task-plan-only-trap.md']) ok(BENCH_ONLY_FILE.test(f), f);
    for (const f of ['humanize.ts', 'tasks.ts', 'task-runner.ts', 'README.md', 'human-list.json.bak']) {
      strictEqual(BENCH_ONLY_FILE.test(f), false, f);
    }
  });
});
