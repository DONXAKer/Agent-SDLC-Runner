import { strictEqual, notStrictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readRequirementsHash, resolvedRequirementsHash } from '../src/artifacts/resolvedRequirements.ts';
import { autofillPlan } from '../src/run/formAutofill.ts';

describe('отпечаток набора требований', () => {
  it('стабилен к переводу строки и чувствителен к задаче и ответам человека', () => {
    const first = resolvedRequirementsHash('# Intent\r\nClaim 1', '# Answers\r\nA: 10');
    strictEqual(first, resolvedRequirementsHash('# Intent\nClaim 1', '# Answers\nA: 10'));
    notStrictEqual(first, resolvedRequirementsHash('# Intent\nClaim 2', '# Answers\nA: 10'));
    notStrictEqual(first, resolvedRequirementsHash('# Intent\nClaim 1', '# Answers\nA: 11'));
  });

  it('рантайм вписывает hash в механическое поле плана, а проверка его извлекает', () => {
    const hash = 'a'.repeat(64);
    const result = autofillPlan('- **Требования (SHA-256):** ‹sha256 требований›', {
      title: 'demo', explorationDone: false, clarificationDone: false, base: 'none', requirementsHash: hash,
    });
    strictEqual(readRequirementsHash(result.text), hash);
    strictEqual(result.filled, 1);
  });
});
