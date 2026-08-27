/**
 * Конфигурация внешних MCP-серверов: `.mcp.json` проекта как база, конфиг раннера как
 * переопределение.
 *
 * Проверяется прежде всего граница строгости. Опечатка в описании роняет загрузку — она
 * верной сама не станет. Недоступный сервер и отсутствующий или битый `.mcp.json` загрузку
 * НЕ роняют: редактор может быть выключен, а раннер обязан стартовать и без него.
 */

import { ok, strictEqual, throws } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { ProjectConfig } from '../src/config/schema.ts';
import { resolveMcp, rulesForStage } from '../src/config/mcp.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Проект во временном каталоге: `.mcp.json` пишется, если он задан. */
function project(mcpFile: string | null, mcp: ProjectConfig['mcp']): ProjectConfig {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-mcpcfg-'));
  roots.push(root);
  if (mcpFile !== null) writeFileSync(join(root, '.mcp.json'), mcpFile, 'utf8');
  return {
    name: 'демо',
    projectRoot: root,
    activeProfile: 'x',
    maxBudgetUsd: 1,
    profiles: {},
    ...(mcp === undefined ? {} : { mcp }),
  };
}

const BASE = JSON.stringify({
  mcpServers: {
    unreal: {
      type: 'stdio',
      command: 'uv.exe',
      args: ['--directory', 'py', 'run', 'server.py'],
      env: { MCP_PROJECT_ROOT: 'client' },
    },
    ue58: { type: 'http', url: 'http://127.0.0.1:8137/mcp' },
  },
});

describe('конфигурация MCP: слияние базы и переопределения', () => {
  it('сервер из .mcp.json, не упомянутый в конфиге, выключен', () => {
    // Умолчание запретительное: `.mcp.json` пишется для Claude Code, где каждое
    // подключение подтверждает человек, и новый сервер в чужом файле не должен молча
    // расширять досягаемость раннера.
    const setup = resolveMcp(project(BASE, { enabled: true }), '/cfg');
    strictEqual(setup.servers.length, 0);
  });

  it('unlistedServers: on включает всё, что есть в файле проекта', () => {
    const setup = resolveMcp(project(BASE, { enabled: true, unlistedServers: 'on' }), '/cfg');
    strictEqual(setup.servers.length, 2);
  });

  it('переопределение меняет параметры, а env сливается по ключам', () => {
    const setup = resolveMcp(
      project(BASE, {
        enabled: true,
        servers: { unreal: { enabled: true, env: { EXTRA: '1' }, callTimeoutMs: 5000 } },
      }),
      '/cfg',
    );
    const s = setup.servers[0];
    ok(s !== undefined && s.transport === 'stdio');
    strictEqual(s.command, 'uv.exe');
    // Команда и аргументы из базы, переменные — объединение.
    strictEqual(s.args.join(' '), '--directory py run server.py');
    strictEqual(s.env['MCP_PROJECT_ROOT'], 'client');
    strictEqual(s.env['EXTRA'], '1');
    strictEqual(s.callTimeoutMs, 5000);
  });

  it('args заменяются целиком, а не поэлементно', () => {
    const setup = resolveMcp(
      project(BASE, { enabled: true, servers: { unreal: { enabled: true, args: ['-m', 'x'] } } }),
      '/cfg',
    );
    const s = setup.servers[0];
    ok(s !== undefined && s.transport === 'stdio');
    strictEqual(s.args.join(' '), '-m x');
  });

  it('сервера нет в файле проекта, но он полностью описан в конфиге — добавляется', () => {
    const setup = resolveMcp(
      project(null, {
        enabled: true,
        servers: { свой: { enabled: true, type: 'http', url: 'http://localhost:9/mcp' } },
      }),
      '/cfg',
    );
    strictEqual(setup.servers.length, 1);
  });

  it('${VAR} разворачивается из окружения; неразвёрнутая переменная загрузку не роняет', () => {
    process.env['SDLC_TEST_MCP_TOKEN'] = 'значение';
    const setup = resolveMcp(
      project(null, {
        enabled: true,
        servers: {
          a: { enabled: true, type: 'http', url: 'http://x/${SDLC_TEST_MCP_TOKEN}' },
          b: { enabled: true, type: 'http', url: 'http://x/${НЕТ_ТАКОЙ_ПЕРЕМЕННОЙ_XYZ}' },
        },
      }),
      '/cfg',
    );
    delete process.env['SDLC_TEST_MCP_TOKEN'];
    const urls = setup.servers.map((s) => (s.transport === 'http' ? s.url : ''));
    ok(urls.some((u) => u.endsWith('/значение')));
    // Неразвёрнутое остаётся как есть: подстановка пустой строки дала бы 401 вместо
    // внятного «переменная не задана», а отказ загрузки — раннер, не стартующий из-за
    // чужого окружения.
    ok(urls.some((u) => u.includes('${НЕТ_ТАКОЙ_ПЕРЕМЕННОЙ_XYZ}')));
  });
});

describe('конфигурация MCP: где ошибка, а где обычное дело', () => {
  it('нет .mcp.json — просто нет серверов', () => {
    const setup = resolveMcp(project(null, { enabled: true }), '/cfg');
    strictEqual(setup.servers.length, 0);
    strictEqual(setup.fileProblem, null);
  });

  it('битый .mcp.json не роняет загрузку, но и не молчит', () => {
    const setup = resolveMcp(project('{ это не json', { enabled: true }), '/cfg');
    strictEqual(setup.servers.length, 0);
    ok(setup.fileProblem !== null);
  });

  it('http без url — ошибка загрузки: опечатка верной не станет', () => {
    throws(
      () =>
        resolveMcp(
          project(null, { enabled: true, servers: { a: { enabled: true, type: 'http' } } }),
          '/cfg',
        ),
      /url/,
    );
  });

  it('ссылка на сервер, которого нет, — ошибка загрузки', () => {
    throws(
      () =>
        resolveMcp(
          project(BASE, {
            enabled: true,
            servers: { unreal: { enabled: true } },
            stages: { chunk: { нет_такого: ['x'] } },
          }),
          '/cfg',
        ),
      /не объявлен/,
    );
  });

  it('неизвестный этап в stages — ошибка загрузки', () => {
    throws(
      () =>
        resolveMcp(
          project(BASE, {
            enabled: true,
            servers: { unreal: { enabled: true } },
            stages: { какой_то: { unreal: ['x'] } },
          }),
          '/cfg',
        ),
      /неизвестный этап/,
    );
  });

  it('имя сервера sdlc занято внутренним сервером раннера', () => {
    throws(
      () =>
        resolveMcp(
          project(null, {
            enabled: true,
            servers: { sdlc: { enabled: true, type: 'http', url: 'http://x/mcp' } },
          }),
          '/cfg',
        ),
      /sdlc/,
    );
  });
});

describe('конфигурация MCP: разрешительный список', () => {
  const withStages = (tools: unknown[]): ProjectConfig =>
    project(BASE, {
      enabled: true,
      servers: { unreal: { enabled: true } },
      stages: { chunk: { unreal: tools as never } },
    });

  it('строка — это правило с классом write по умолчанию', () => {
    // Неназванный класс считается изменяющим: ошибка в эту сторону стоит лишнего
    // подтверждения, в обратную — необратимого вызова без подтверждения вовсе.
    const setup = resolveMcp(withStages(['spawn_actor']), '/cfg');
    const rules = rulesForStage(setup, 'chunk');
    strictEqual(rules[0]?.mode, 'write');
  });

  it('шаблон не может быть read', () => {
    throws(() => resolveMcp(withStages([{ tool: 'get_*', mode: 'read' }]), '/cfg'), /шаблон/);
  });

  it('read с записывающим аргументом-путём — ошибка описания', () => {
    throws(
      () =>
        resolveMcp(
          withStages([
            { tool: 'import_texture', mode: 'read', pathArgs: [{ key: 'file', access: 'write' }] },
          ]),
          '/cfg',
        ),
      /read/,
    );
  });

  it('этап без описания не получает MCP вовсе', () => {
    const setup = resolveMcp(withStages(['spawn_actor']), '/cfg');
    strictEqual(rulesForStage(setup, 'verify').length, 0);
  });
});
