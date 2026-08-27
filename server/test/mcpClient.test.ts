/**
 * Клиент и хаб внешних MCP-серверов — против НАСТОЯЩЕГО сервера в памяти.
 *
 * Двойник здесь не мок нашего кода, а `McpServer` из того же SDK, соединённый
 * `InMemoryTransport`: проверяется реальный протокол, включая то, как сервер отдаёт
 * ошибку инструмента и как выглядит `content`. Мок вместо этого проверял бы, что мы
 * вызвали свою же функцию.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { McpServerSpec } from '../src/config/mcp.ts';
import { McpHub } from '../src/mcp/McpHub.ts';
import type { TransportFactory } from '../src/mcp/McpClient.ts';
import { foldContent, imageSaver } from '../src/mcp/content.ts';

const tmp = mkdtempSync(join(tmpdir(), 'sdlc-mcp-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const spec = (name: string): McpServerSpec => ({
  name,
  transport: 'stdio',
  command: 'нет-такой-команды',
  args: [],
  env: {},
  cwd: tmp,
  connectTimeoutMs: 2_000,
  callTimeoutMs: 2_000,
  pollingTools: [],
});

/** Сервер в памяти: два инструмента — читающий и падающий. */
function inMemoryServer(): TransportFactory {
  return () => {
    const server = new McpServer({ name: 'двойник', version: '0.0.1' });

    server.registerTool('pie_status', { description: 'состояние PIE', inputSchema: {} }, () => ({
      content: [{ type: 'text', text: 'PIE не запущен' }],
    }));

    server.registerTool(
      'compile_blueprint',
      { description: 'компиляция', inputSchema: { path: z.string() } },
      ({ path }) => ({ content: [{ type: 'text', text: `не собралось: ${path}` }], isError: true }),
    );

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void server.connect(serverSide);
    return clientSide;
  };
}

/** Фабрика, которая всегда падает: так выглядит выключенный редактор. */
const brokenTransport: TransportFactory = () => {
  throw new Error('соединение не установлено');
};

describe('MCP: клиент против сервера в памяти', () => {
  it('подключается, отдаёт инструменты и исполняет вызов', async () => {
    const hub = new McpHub([spec('unreal')], inMemoryServer());
    strictEqual((await hub.ensureReady(['unreal'])).length, 0);

    const tools = hub.tools(['unreal']).map((t) => t.name);
    ok(tools.includes('mcp__unreal__pie_status'));

    const out = await hub.call('unreal', 'pie_status', {});
    strictEqual(out.ok, true);
    ok(out.text.includes('PIE не запущен'));
    await hub.close();
  });

  it('isError сервера — неуспех инструмента, а не крах этапа', async () => {
    const hub = new McpHub([spec('unreal')], inMemoryServer());
    await hub.ensureReady(['unreal']);
    const out = await hub.call('unreal', 'compile_blueprint', { path: '/Game/BP' });
    strictEqual(out.ok, false);
    ok(out.text.includes('/Game/BP'));
    await hub.close();
  });

  it('неизвестный инструмент не бросает наружу — виток продолжается', async () => {
    const hub = new McpHub([spec('unreal')], inMemoryServer());
    await hub.ensureReady(['unreal']);
    const out = await hub.call('unreal', 'нет_такого', {});
    strictEqual(out.ok, false);
    await hub.close();
  });

  it('недоступный сервер даёт состояние с причиной, а не исключение', async () => {
    const hub = new McpHub([spec('unreal')], brokenTransport);
    const failed = await hub.ensureReady(['unreal']);
    strictEqual(failed[0], 'unreal');
    const s = hub.status('unreal');
    strictEqual(s.state, 'unavailable');
    ok(s.reason !== null && s.reason.includes('соединение'));
    // И вызов к нему тоже не бросает: модель получает текст, а не упавший этап.
    strictEqual((await hub.call('unreal', 'pie_status', {})).ok, false);
    await hub.close();
  });

  it('падение одного сервера не касается второго', async () => {
    const good = inMemoryServer();
    const hub = new McpHub([spec('живой'), spec('мёртвый')], (s, onErr) =>
      s.name === 'живой' ? good(s, onErr) : brokenTransport(s, onErr),
    );
    const failed = await hub.ensureReady(['живой', 'мёртвый']);
    strictEqual(failed.join(), 'мёртвый');
    strictEqual(hub.status('живой').state, 'connected');
    strictEqual((await hub.call('живой', 'pie_status', {})).ok, true);
    await hub.close();
  });

  it('в показанном оператору нет значений env и заголовков', async () => {
    // Спека собирается целиком, а не спредом: `McpServerSpec` — union из stdio и http,
    // и спред union'а компилятор не сузит до нужной ветки.
    const withSecret: McpServerSpec = {
      name: 'unreal',
      transport: 'stdio',
      command: 'нет-такой-команды',
      args: [],
      env: { TOKEN: 'секрет' },
      cwd: tmp,
      connectTimeoutMs: 2_000,
      callTimeoutMs: 2_000,
      pollingTools: [],
    };
    const hub = new McpHub([withSecret], inMemoryServer());
    await hub.ensureReady(['unreal']);
    const info = hub.info(new Map())[0];
    ok(info !== undefined);
    strictEqual(JSON.stringify(info).includes('секрет'), false);
    strictEqual(info.envKeys.join(), 'TOKEN');
    await hub.close();
  });
});

describe('MCP: свёртка ответа', () => {
  it('изображение уходит файлом, а в контекст — путь и размер', () => {
    // Скриншот PIE в base64 — это десятки тысяч токенов: в 16K-контур он не влезает,
    // а локальные модели почти все и не мультимодальны.
    const data = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const out = foldContent(
      { content: [{ type: 'image', data, mimeType: 'image/png' }] },
      { saveImage: imageSaver(() => join(tmp, 'shot')) },
    );
    ok(out.ok);
    ok(out.text.includes('shot.png'));
    ok(readdirSync(tmp).includes('shot.png'));
    // Самого base64 в тексте для модели нет.
    strictEqual(out.text.includes(data), false);
  });

  it('без сохранялки изображение описывается, но не молчит', () => {
    const out = foldContent({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
    ok(out.text.includes('изображение'));
  });

  it('провал в конверте ответа не считается успехом', () => {
    // Наблюдение с живого сервера WarCard при выключенном редакторе: `isError` он не
    // ставит, а провал объявляет полем внутри JSON. Записать это успехом значило бы
    // отдать в ленту витка тихий успех.
    const out = foldContent({
      content: [
        {
          type: 'text',
          text: '{"ok": false, "error": {"message": "No Unreal connection"}, "success": false}',
        },
      ],
    });
    strictEqual(out.ok, false);
    // Текст модели отдаётся как есть: причину она обязана прочитать целиком.
    ok(out.text.includes('No Unreal connection'));
  });

  it('обычный успешный конверт успехом и остаётся', () => {
    const out = foldContent({ content: [{ type: 'text', text: '{"ok": true, "exists": false}' }] });
    strictEqual(out.ok, true);
  });

  it('не-JSON и вложенные поля разбором не трогаются', () => {
    // Узкое правило: только весь ответ целиком и только верхний уровень. «ok: false»
    // внутри данных — это данные, а не статус вызова.
    strictEqual(foldContent({ content: [{ type: 'text', text: 'ok: false' }] }).ok, true);
    strictEqual(
      foldContent({ content: [{ type: 'text', text: '{"data": {"ok": false}}' }] }).ok,
      true,
    );
  });

  it('пустой ответ называется пустым, а не выглядит успехом без содержимого', () => {
    const out = foldContent({ content: [] });
    ok(out.ok);
    ok(out.text.includes('пустой'));
  });
});
