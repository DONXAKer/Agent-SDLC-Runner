/**
 * Тесты лимитов хранения: одно число на категорию, неизвестная категория — null, не дефолт.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { limitFor } from '../src/index.ts';

describe('лимиты хранения', () => {
  it('базовый лимит по категориям', () => {
    strictEqual(limitFor('standard'), 200);
    strictEqual(limitFor('fragile'), 80);
    strictEqual(limitFor('liquid'), 60);
  });

  it('неизвестная категория — null, а не молчаливый дефолт', () => {
    strictEqual(limitFor('unknown'), null);
    strictEqual(limitFor('Standard'), null); // регистр значим: опечатка не должна тихо сойти за standard
  });
});
