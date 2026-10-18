import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const target = await import(pathToFileURL(join(resolve(process.env.BENCH_TARGET_DIR), 'src/index.ts')).href);
test('G1 [contract]: additive surcharge is applied to rate before rounding', () => {
  for (const [vehicle, rate] of Object.entries({ car: 76, van: 115, truck: 248 })) {
    for (let km = 0; km <= 73; km++) {
      assert.equal(target.trailerFuelMl(km, vehicle), Math.ceil(km * (rate + 20) / 100) * 100, `${vehicle}, ${km}`);
      assert.equal(target.fuelMl(km, vehicle), Math.ceil(km * rate / 100) * 100);
    }
  }
});
test('G2 [contract]: unknown class stays explicit', () => assert.equal(target.trailerFuelMl(17, 'unregistered-vehicle'), null));
