import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const target = await import(pathToFileURL(join(resolve(process.env.BENCH_TARGET_DIR), 'src/index.ts')).href);
test('G1 [contract]: raw winter calculation across classes and rounding boundaries', () => {
  for (const [vehicle, rate] of Object.entries({ car: 76, van: 115, truck: 248 })) {
    for (let km = 0; km <= 73; km++) {
      const raw = km * rate;
      assert.equal(target.winterFuelMl(km, vehicle), raw + Math.floor((raw * 15 + 50) / 100), `${vehicle}, ${km}`);
      assert.equal(target.fuelMl(km, vehicle), Math.ceil(raw / 100) * 100);
    }
  }
});
test('G2 [contract]: unknown class stays explicit', () => assert.equal(target.winterFuelMl(17, 'unregistered-vehicle'), null));
