import { deepStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planConstantsMissingFromDiff } from '../src/run/planConstants.ts';

describe('planConstantsMissingFromDiff', () => {
  it('план без констант в распознанном формате — молчит', () => {
    const plan = 'Обычная проза без бэктик-констант, хотя тут есть число 120.';
    deepStrictEqual(planConstantsMissingFromDiff(plan, '+ const x = 1;'), []);
  });

  it('константа с тем же числом в diff — молчит', () => {
    const plan = 'Порог: `LONGEST_SIDE_LIMIT_CM = 120`.';
    const diff = '+export const LONGEST_SIDE_LIMIT_CM = 120;';
    deepStrictEqual(planConstantsMissingFromDiff(plan, diff), []);
  });

  it('имени константы в diff нет вовсе — расхождение', () => {
    const plan = 'Порог: `LONGEST_SIDE_LIMIT_CM = 120`.';
    const diff = '+export const OVERSIZE_THRESHOLD_CM = 100;';
    const r = planConstantsMissingFromDiff(plan, diff);
    deepStrictEqual(r.length, 1);
    deepStrictEqual(/LONGEST_SIDE_LIMIT_CM = 120.*нет вовсе/.test(r[0]!), true, r[0]);
  });

  it('имя есть, число другое — расхождение с обоими числами', () => {
    const plan = 'Ставка: `SIDE_SURCHARGE_PCT = 40`.';
    const diff = '+export const SIDE_SURCHARGE_PCT = 20;';
    const r = planConstantsMissingFromDiff(plan, diff);
    deepStrictEqual(r.length, 1);
    deepStrictEqual(/SIDE_SURCHARGE_PCT = 40.*SIDE_SURCHARGE_PCT = 20/.test(r[0]!), true, r[0]);
  });

  it('несколько констант — каждая проверяется независимо', () => {
    const plan = '`A = 1`, `B = 2`, `C = 3`.';
    const diff = '+const A = 1;\n+const B = 99;\n// C нигде не упомянута';
    const r = planConstantsMissingFromDiff(plan, diff);
    deepStrictEqual(r.length, 2);
  });

  it('повтор одного имени в плане — берётся первое упоминание', () => {
    const plan = '`X = 5` в шаге 1, позже уточнение `X = 5` в шаге 3.';
    const diff = '+const X = 5;';
    deepStrictEqual(planConstantsMissingFromDiff(plan, diff), []);
  });
});
