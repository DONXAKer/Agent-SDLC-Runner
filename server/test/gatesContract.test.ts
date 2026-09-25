/**
 * Контракт гейт-скрипта (`SDLC.md` → «Контракт гейт-скрипта»): статус — по последней
 * JSON-строке stdout, код возврата — зеркало; `missing_tool` → ⏭ и среда; чужое имя гейта
 * статуса не даёт; без JSON — прежнее правило по коду, где 3 и 2 — ⏭ без среды.
 *
 * Прогоны — настоящей командой в настоящей оболочке (`printf`/`echo` + `exit`), как в
 * `gateToolMissing.test.ts`: подделать контракт моком значило бы проверить свою константу.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseGateContract } from '../src/gates/contract.ts';
import { parseGates } from '../src/gates/gatesFile.ts';
import { runGates } from '../src/gates/run.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function gatesWith(name: string, command: string): { root: string; gates: ReturnType<typeof parseGates> } {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-contract-'));
  roots.push(root);
  const text = ['# Набор', '', '## Набор', '', '| Гейт | Вкл | Где отчитывается | Чем реализован |', '|---|---|---|---|', `| ${name} | да | этап 6 | \`${command}\` |`, ''].join('\n');
  writeFileSync(join(root, 'gates.md'), text, 'utf8');
  return { root, gates: parseGates(text) };
}

async function run(name: string, command: string) {
  const { root, gates } = gatesWith(name, command);
  const results = await runGates({ gates, projectRoot: root, projectName: 'проба', planFiles: [], baseline: null, timeoutMs: 30_000, externalStatuses: {}, onWarn: () => {}, onResult: () => {} });
  const r = results.find((x) => x.name === name);
  ok(r !== undefined);
  return r;
}

/** JSON-строка контракта, безопасная для echo обеих оболочек: без кавычек оболочки внутри. */
function jsonLine(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

describe('parseGateContract', () => {
  it('последняя строка — JSON с gate и status; человекочитаемое выше не мешает', () => {
    const c = parseGateContract(`✅ Проба: ок\n  - src/a.ts:12\n${jsonLine({ gate: 'Проба', status: 'pass', evidence: ['src/a.ts:12'], detail: 'ок', missing_tool: null })}\n`);
    deepStrictEqual(c, { gate: 'Проба', status: 'pass', evidence: ['src/a.ts:12'], detail: 'ок', missing_tool: null });
  });

  it('не JSON, чужой статус или без gate — контракта нет', () => {
    strictEqual(parseGateContract('all good'), null);
    strictEqual(parseGateContract(jsonLine({ gate: 'X', status: 'ok' })), null);
    strictEqual(parseGateContract(jsonLine({ status: 'pass' })), null);
  });
});

describe('статус гейта по контракту', () => {
  // Кавычки внутри JSON — двойные; команда оборачивает строку в одинарные для sh, а в cmd.exe
  // одинарные кавычки печатаются как есть — поэтому JSON без пробелов и через printf/echo не
  // годится для обеих оболочек. Пишем скрипт в файл и зовём его через node — он есть везде.
  function script(root: string, body: string): string {
    const p = join(root, 'gate.cjs');
    writeFileSync(p, body, 'utf8');
    return `node ${JSON.stringify(p)}`;
  }

  it('fail по контракту при коде 1 — ❌ с деталью и уликами', async () => {
    const { root, gates } = gatesWith('Проба', 'true');
    const cmd = script(root, `console.log('x'); console.log(${JSON.stringify(jsonLine({ gate: 'Проба', status: 'fail', evidence: ['src/a.ts'], detail: 'файл вне плана', missing_tool: null }))}); process.exit(1);`);
    const g = parseGates(['# Набор', '', '## Набор', '', '| Гейт | Вкл | Где отчитывается | Чем реализован |', '|---|---|---|---|', `| Проба | да | этап 6 | \`${cmd}\` |`, ''].join('\n'));
    const results = await runGates({ gates: g, projectRoot: root, projectName: 'проба', planFiles: [], baseline: null, timeoutMs: 30_000, externalStatuses: {}, onWarn: () => {}, onResult: () => {} });
    const r = results[0]!;
    void gates;
    strictEqual(r.status, '❌');
    strictEqual(r.contract, 'json');
    deepStrictEqual(r.evidence, ['src/a.ts']);
    ok(r.lastLine.includes('файл вне плана'), r.lastLine);
    strictEqual(r.envBlocked, false);
  });

  it('skip с missing_tool при коде 3 — ⏭, среда, улика инструмента', async () => {
    const { root } = gatesWith('Тесты', 'true');
    const cmd = script(root, `console.log(${JSON.stringify(jsonLine({ gate: 'Тесты', status: 'skip', evidence: [], detail: 'нет JDK', missing_tool: 'java: command not found' }))}); process.exit(3);`);
    const r = await run('Тесты', cmd);
    strictEqual(r.status, '⏭');
    strictEqual(r.envBlocked, true);
    strictEqual(r.missingTool, 'java: command not found');
  });

  it('pass с missing_tool — контракт нарушен: ⏭, не ✅', async () => {
    const { root } = gatesWith('Тесты', 'true');
    const cmd = script(root, `console.log(${JSON.stringify(jsonLine({ gate: 'Тесты', status: 'pass', evidence: [], detail: 'прошло', missing_tool: 'mvn' }))}); process.exit(0);`);
    const r = await run('Тесты', cmd);
    strictEqual(r.status, '⏭');
    ok(r.lastLine.includes('контракт нарушен'), r.lastLine);
  });

  it('pass по контракту, но код 1 — берётся худший: ❌', async () => {
    const { root } = gatesWith('Проба', 'true');
    const cmd = script(root, `console.log(${JSON.stringify(jsonLine({ gate: 'Проба', status: 'pass', evidence: [], detail: 'ок', missing_tool: null }))}); process.exit(1);`);
    const r = await run('Проба', cmd);
    strictEqual(r.status, '❌');
    ok(r.lastLine.includes('разошёлся с контрактом'), r.lastLine);
  });

  it('скрипт назвал чужой гейт — статус не принят, ⏭ без среды', async () => {
    const { root } = gatesWith('Проба', 'true');
    const cmd = script(root, `console.log(${JSON.stringify(jsonLine({ gate: 'Другой', status: 'pass', evidence: [], detail: 'ок', missing_tool: null }))}); process.exit(0);`);
    const r = await run('Проба', cmd);
    strictEqual(r.status, '⏭');
    strictEqual(r.envBlocked, false);
    ok(r.lastLine.includes('«Другой»'), r.lastLine);
  });

  it('без JSON: коды 2 и 3 — обычный ❌ (make/mocha/pytest отдают их на провале), код 0 — ✅', async () => {
    strictEqual((await run('Проба', 'exit 3')).status, '❌');
    strictEqual((await run('Проба', 'exit 3')).envBlocked, false);
    strictEqual((await run('Проба', 'exit 2')).status, '❌');
    strictEqual((await run('Проба', 'exit 0')).contract, 'exit-code');
  });
});
