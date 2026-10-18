/**
 * Тесты норм расхода: одно число на класс, неизвестный класс — null, не дефолт.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rateFor } from '../src/index.ts';

describe('нормы расхода', () => {
  it('базовая норма по классам', () => {
    strictEqual(rateFor('car'), 76);
    strictEqual(rateFor('van'), 115);
    strictEqual(rateFor('truck'), 248);
  });

  it('неизвестный класс — null, а не молчаливый дефолт', () => {
    strictEqual(rateFor('motorcycle'), null);
    strictEqual(rateFor('Car'), null); // регистр значим: опечатка не должна тихо сойти за car
  });
});
