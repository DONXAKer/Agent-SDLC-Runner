/**
 * Preflight набора гейтов (`gates/preflight.ts`, порт `gates-preflight.py`): исполнимость
 * первого слова команды в PATH или от корня проекта, скрипт интерпретатора на месте, отказ
 * пола безопасности — неисполнимость. Ничего не запускается.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseGates } from '../src/gates/gatesFile.ts';
import { preflightGateBlockers, preflightGates, scriptOf } from '../src/gates/preflight.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function gates(rows: string[]): ReturnType<typeof parseGates> {
  return parseGates(['# Набор', '', '## Набор', '', '| Гейт | Вкл | Где отчитывается | Чем реализован |', '|---|---|---|---|', ...rows, ''].join('\n'));
}

describe('preflightGates', () => {
  it('PATH, путь от корня, скрипт интерпретатора, отказ пола, строка без команды', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-preflight-'));
    roots.push(root);
    writeFileSync(join(root, 'check.js'), '', 'utf8');
    const rows = await preflightGates(
      gates([
        '| В PATH | да | этап 6 | `node --version` |',
        '| Нет в PATH | да | этап 6 | `frobnicate-9000 --all` |',
        '| Скрипт есть | да | этап 6 | `node check.js` |',
        '| Скрипта нет | да | этап 6 | `node tools/missing.js` |',
        '| Путь от корня | да | этап 6 | `./gradlew test` |',
        '| Отклонена | да | этап 6 | `sudo make test` |',
        '| Проза | да | этап 6 | встроенная реализация |',
        '| Ранний | да | этап 4 | `frobnicate-9000` |',
        '| Выключен | нет | этап 6 | `frobnicate-9000` |',
      ]),
      root,
    );
    deepStrictEqual(
      rows.map((r) => [r.gate, r.status]),
      [
        ['В PATH', 'ok'],
        ['Нет в PATH', 'missing'],
        ['Скрипт есть', 'ok'],
        ['Скрипта нет', 'missing'],
        ['Путь от корня', 'missing'],
        ['Отклонена', 'denied'],
        ['Проза', 'no-command'],
      ],
    );
    ok(rows[3]!.detail.includes('tools/missing.js'), rows[3]!.detail);
  });

  it('блокеры называют гейт и дают готовую строку долга', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-preflight-'));
    roots.push(root);
    const b = await preflightGateBlockers(gates(['| Тесты | да | этап 6 | `frobnicate-9000 test` |', '| Сборка | да | этап 6 | `node --version` |']), root);
    strictEqual(b.length, 1);
    ok(b[0]!.includes('«Тесты»') && b[0]!.includes('blocked_env') && b[0]!.includes('| Тесты: нет «frobnicate-9000»'), b[0]);
  });

  it('scriptOf: путь скрипта после интерпретатора, флаги пропускаются, -m/-c/-e — нет файла', () => {
    strictEqual(scriptOf('python -u tools/x.py --json', 'python'), 'tools/x.py');
    strictEqual(scriptOf('python -m pytest', 'python'), null);
    strictEqual(scriptOf('node -e 1', 'node'), null);
    strictEqual(scriptOf('make test', 'make'), null);
  });
});
