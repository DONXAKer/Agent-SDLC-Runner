/**
 * Константы методологии — из `sdlc-constants.json`: установочная копия рядом с кодом
 * обязана совпадать с эталоном (когда он есть на машине), а списки рантайма — с файлом
 * (иначе модули не грузятся вовсе — `assertSameList`).
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { SDLC_CONSTANTS, SDLC_CONSTANTS_SOURCE, assertSameList, constantsCandidates } from '../src/config/constants.ts';
import { loadConfig } from '../src/config/load.ts';
import { AXES } from '../src/artifacts/planAxes.ts';
import { builtinFor } from '../src/gates/builtin/index.ts';
import { UNSCRIPTED_GATES } from '../src/run/stages/verify/gates.ts';
import { gateKey } from '../src/gates/gatesFile.ts';

function methodologyDir(): string | null {
  const fromEnv = process.env['SDLC_METHODOLOGY_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const d = loadConfig().runner.methodologyDir;
    return typeof d === 'string' && d !== '' ? d : null;
  } catch {
    return null;
  }
}

describe('sdlc-constants.json', () => {
  it('загружены и названы источником', () => {
    ok(SDLC_CONSTANTS.mandatory_gates.length === 5);
    ok(constantsCandidates().includes(SDLC_CONSTANTS_SOURCE) || existsSync(SDLC_CONSTANTS_SOURCE));
    deepStrictEqual([...AXES], SDLC_CONSTANTS.axes);
  });

  const dir = methodologyDir();
  const original = dir === null ? null : join(dir, 'sdlc-constants.json');
  it('установочная копия совпадает с эталоном', { skip: original === null || !existsSync(original) }, () => {
    const bundled = resolve(import.meta.dirname, '..', 'src', 'config', 'sdlc-constants.json');
    deepStrictEqual(JSON.parse(readFileSync(bundled, 'utf8')), JSON.parse(readFileSync(original!, 'utf8')));
  });

  it('каждый гейт перечня этапа 6 исполним рантаймом: встроенная реализация либо строка проверяющего', () => {
    const unscripted = new Set(UNSCRIPTED_GATES.map(gateKey));
    const missing = SDLC_CONSTANTS.gates
      .filter((g) => g.stage === 'этап 6')
      .map((g) => g.name)
      .filter((n) => builtinFor(n) === null && !unscripted.has(gateKey(n)));
    deepStrictEqual(missing, []);
  });

  it('assertSameList ловит расхождение', () => {
    let threw = false;
    try {
      assertSameList('проба', ['a'], ['b']);
    } catch {
      threw = true;
    }
    strictEqual(threw, true);
  });
});
