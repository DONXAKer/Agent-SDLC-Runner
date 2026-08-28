/**
 * Отказ инструмента — не провал гейта.
 *
 * Требование методологии (этап 6): «команда, упавшая на отказ инструмента (`git: not
 * found`, `java: command not found`), не даёт права поставить ✅ — только ⏭: её код
 * возврата свидетельствует о среде, а не о предмете гейта». До этого раннер ставил ❌ и
 * ронял вердикт по причине, к работе витка отношения не имеющей.
 *
 * Проверка идёт настоящей командой в настоящей оболочке: подделать код возврата 127
 * моком значило бы проверить свою же константу.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runGates } from '../src/gates/run.ts';
import { parseGates } from '../src/gates/gatesFile.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Набор из одной строки с командой в обратных кавычках. */
function gatesWith(command: string): { root: string; gates: ReturnType<typeof parseGates> } {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-gate-'));
  roots.push(root);
  const text = [
    '# Набор гейтов: проба',
    '',
    // Заголовок секции обязателен: парсер берёт таблицу под «## Набор», а не любую
    // таблицу в файле — иначе примером из прозы можно было бы завести гейт.
    '## Набор',
    '',
    '| Гейт | Вкл | Где отчитывается | Чем реализован |',
    '|---|---|---|---|',
    `| Проба | да | этап 6 | \`${command}\` |`,
    '',
  ].join('\n');
  writeFileSync(join(root, 'gates.md'), text, 'utf8');
  return { root, gates: parseGates(text) };
}

const runOne = async (command: string, root: string, gates: ReturnType<typeof parseGates>) => {
  const results = await runGates({
    gates,
    projectRoot: root,
    projectName: 'проба',
    planFiles: [],
    baseline: null,
    timeoutMs: 30_000,
    externalStatuses: {},
    onWarn: () => {},
    onResult: () => {},
  });
  return results.find((r) => r.name === 'Проба');
};

describe('статус гейта: среда против предмета проверки', () => {
  it('код «команды нет» — ⏭ с названной причиной, а не ❌', async () => {
    // Именно кодом, а не запуском несуществующей команды: у POSIX-оболочки это 127, а
    // Windows-`cmd` на том же месте отдаёт 1 и текст в кодировке консоли — на нём проверка
    // проверяла бы локаль машины, а не правило.
    const { root, gates } = gatesWith('exit 127');
    const r = await runOne('', root, gates);

    ok(r !== undefined);
    strictEqual(r.status, '⏭');
    ok(r.lastLine.includes('инструмента нет в среде'), 'причина названа словами, а не кодом');
  });

  it('команда есть и провалилась по делу — по-прежнему ❌', async () => {
    // Отличать надо именно эти два случая: «нечем проверить» и «проверка не прошла».
    const { root, gates } = gatesWith('exit 1');
    const r = await runOne('', root, gates);

    ok(r !== undefined);
    strictEqual(r.status, '❌');
  });

  it('команда прошла — ✅', async () => {
    const { root, gates } = gatesWith('exit 0');
    const r = await runOne('', root, gates);

    ok(r !== undefined);
    strictEqual(r.status, '✅');
  });
});
