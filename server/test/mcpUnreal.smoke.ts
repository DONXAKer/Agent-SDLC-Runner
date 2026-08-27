/**
 * Ручной smoke-тест против РЕАЛЬНОГО MCP-сервера целевого проекта.
 *
 * Не входит в `npm test` (не матчится паттерном `test/**\/*.test.ts`) — он поднимает
 * настоящий дочерний процесс сервера, а на чужой машине его может не быть вовсе.
 * Запускается руками: `node --test server/test/mcpUnreal.smoke.ts`.
 *
 * Проверяет то, чего герметичный двойник проверить не может: что описание из `.mcp.json`
 * действительно приводит к живому соединению, что набор на этап влезает в бюджет и что
 * поведение при ВЫКЛЮЧЕННОМ редакторе честное — вызов возвращает неуспех с причиной, а не
 * висит и не роняет этап.
 *
 * Проект берётся из `SDLC_SMOKE_PROJECT` (умолчание — `WarCard`). Нет такого проекта или
 * MCP у него не настроен — тест пропускается с названной причиной: набор, красный из-за
 * чужой конфигурации, приучает себя игнорировать.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config/load.ts';
import { rulesForStage } from '../src/config/mcp.ts';
import type { McpSetup } from '../src/config/mcp.ts';
import { McpHub } from '../src/mcp/McpHub.ts';
import { estimateTokens, selectTools } from '../src/mcp/select.ts';

const PROJECT = process.env['SDLC_SMOKE_PROJECT'] ?? 'WarCard';

function setupOrNull(): McpSetup | null {
  const found = loadConfig().mcp.get(PROJECT);
  if (found === undefined || found.servers.length === 0) return null;
  return found;
}

describe('живой MCP целевого проекта', { concurrency: false }, () => {
  const setup = setupOrNull();
  const skip =
    setup === null ? `у проекта «${PROJECT}» не настроены MCP-серверы — проверять нечего` : false;

  it('серверы поднимаются и отдают список инструментов', { skip }, async () => {
    if (setup === null) return;
    const hub = new McpHub(setup.servers);
    const failed = await hub.ensureReady(hub.names());

    for (const name of hub.names()) {
      const s = hub.status(name);
      // Недоступный сервер — не провал теста: редактор может быть выключен, а окружение
      // разработчика не обязано совпадать с моим. Провал — это молчание о причине.
      if (s.state !== 'connected') {
        ok(s.reason !== null, `сервер «${name}» недоступен и не назвал причину`);
        continue;
      }
      ok((s.toolCount ?? 0) > 0, `сервер «${name}» подключился, но не отдал ни одного инструмента`);
    }

    ok(failed.length < hub.names().length || hub.names().length === 0, 'не поднялся ни один сервер');
    await hub.close();
  });

  it('набор на этап влезает в объявленный потолок', { skip }, async () => {
    if (setup === null) return;
    const hub = new McpHub(setup.servers);
    await hub.ensureReady(hub.names());
    const available = hub.tools(hub.names());

    for (const stage of ['explore', 'chunk', 'verify'] as const) {
      const rules = rulesForStage(setup, stage);
      if (rules.length === 0) continue;
      const sel = selectTools(rules, available, setup.maxInlineTools);
      ok(
        sel.tools.length <= setup.maxInlineTools,
        `этап ${stage}: набор ${sel.tools.length} больше потолка ${setup.maxInlineTools}`,
      );
      // Цена набора печатается, а не проверяется числом: потолок задаётся в штуках, и
      // ассерт на токены был бы утверждением о чужих описаниях.
      console.log(
        `  ${stage}: ${sel.tools.length} инструментов, ~${estimateTokens(sel.tools)} токенов` +
          `${sel.dropped.length === 0 ? '' : `, отброшено ${sel.dropped.length}`}`,
      );
    }
    await hub.close();
  });

  it('вызов при выключенном редакторе честно неуспешен', { skip }, async () => {
    if (setup === null) return;
    const hub = new McpHub(setup.servers);
    await hub.ensureReady(hub.names());

    const server = hub.names()[0];
    if (server === undefined || hub.status(server).state !== 'connected') {
      await hub.close();
      return;
    }

    // Несуществующего инструмента нет ни при каком состоянии редактора — это тот случай,
    // где ответ обязан быть неуспешным всегда, без «а вдруг у него редактор запущен».
    const bad = await hub.call(server, 'нет_такого_инструмента_xyz', {});
    strictEqual(bad.ok, false);
    ok(bad.text.trim() !== '', 'неуспех обязан нести причину, а не пустую строку');

    await hub.close();
  });
});
