/**
 * Обзор каталогов (`GET /api/browse`) и добавление проекта (`POST /api/projects`) —
 * containment по `SDLC_BROWSE_ROOT` и симлинк-побег. Регрессии на находки ревью фичи
 * «обзор каталогов + добавление проекта».
 */

import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { listDir } from '../src/fs/browse.ts';
import { createProject } from '../src/config/createProject.ts';
import type { LoadedConfig } from '../src/config/load.ts';

// `mkdtemp` под macOS отдаёт путь через `/tmp`, а `/tmp` сам — симлинк на `/private/tmp`;
// `listDir`/`createProject` канонизируют через realpath, поэтому строим фикстуры от уже
// канонического корня — иначе тест был бы завязан на то, что host не подсовывает symlink
// в общем предке, чего эта же фича обязана переживать.
const rawRoot = mkdtempSync(join(tmpdir(), 'sdlc-browse-'));
const root = realpathSync(rawRoot);
after(() => rmSync(rawRoot, { recursive: true, force: true }));

const browseRoot = join(root, 'browse-root');
const inside = join(browseRoot, 'proj-a');
const outside = join(root, 'outside');
mkdirSync(inside, { recursive: true });
mkdirSync(outside, { recursive: true });

describe('listDir', () => {
  it('листит поддиректории корня', () => {
    const r = listDir(browseRoot, undefined);
    strictEqual(r.parent, null);
    ok(r.entries.some((e) => e.name === 'proj-a'));
  });

  it('поднимается по parent от вложенного каталога', () => {
    const r = listDir(browseRoot, inside);
    strictEqual(r.parent, browseRoot);
  });

  it('отклоняет путь вне browseRoot', () => {
    throws(() => listDir(browseRoot, outside), /вне разрешённого дерева/);
  });

  it('симлинк, ведущий вне browseRoot, не попадает в листинг', () => {
    const link = join(browseRoot, 'escape-link');
    symlinkSync(outside, link);
    try {
      const r = listDir(browseRoot, undefined);
      ok(!r.entries.some((e) => e.name === 'escape-link'));
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('пустой каталог возвращает entries: []', () => {
    const empty = join(browseRoot, 'empty-dir');
    mkdirSync(empty, { recursive: true });
    const r = listDir(browseRoot, empty);
    deepStrictEqual(r.entries, []);
  });
});

describe('createProject', () => {
  const makeConfig = (): LoadedConfig => ({
    dir: mkdtempSync(join(tmpdir(), 'sdlc-config-')),
    runner: {} as LoadedConfig['runner'],
    models: {} as LoadedConfig['models'],
    projects: new Map(),
    mcp: new Map(),
  });

  it('создаёт проект внутри browseRoot', () => {
    const config = makeConfig();
    const p = createProject(config, { name: 'proj-a', projectRoot: inside, browseRoot });
    strictEqual(p.name, 'proj-a');
    ok(config.projects.has('proj-a'));
  });

  it('отклоняет projectRoot вне browseRoot — даже если каталог существует', () => {
    const config = makeConfig();
    throws(
      () => createProject(config, { name: 'proj-b', projectRoot: outside, browseRoot }),
      /вне разрешённого дерева/,
    );
  });

  it('отклоняет несуществующий projectRoot вне browseRoot с той же причиной, не «не найден»', () => {
    const config = makeConfig();
    throws(
      () =>
        createProject(config, {
          name: 'proj-c',
          projectRoot: join(root, 'does-not-exist'),
          browseRoot,
        }),
      /вне разрешённого дерева/,
    );
  });

  it('отклоняет зарезервированное Windows-имя', () => {
    const config = makeConfig();
    throws(() => createProject(config, { name: 'con', projectRoot: inside, browseRoot }), /имя проекта/);
  });
});
