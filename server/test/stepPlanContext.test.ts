import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { stepPlanContext } from '../src/exec/stepPlanContext.ts';

test('короткий план передаётся дословно', () => {
  const plan = '# План\n\n## Контекст-пакет\nДенежный контракт.\n';
  assert.equal(stepPlanContext(plan, 2000), plan);
});

test('контракт из конца длинного плана виден в пределах бюджета', () => {
  const plan = '# План\n' + 'Повторный контекст. '.repeat(1000)
    + '\n## Последствия шагов\ncalculateVat(subtotal, lines): налог от общей суммы.\n'
    + '\n## Контекст-пакет\nДеньги — Kopeck; percent() округляет половину вверх.\n';
  const result = stepPlanContext(plan, 1500);
  assert.ok(result.includes('calculateVat(subtotal, lines)'));
  assert.ok(result.includes('percent()'));
  assert.ok(Buffer.byteLength(result, 'utf8') <= 1500);
  assert.ok(result.includes('# План'));
});

test('без выделенных контрактов сохраняется прежнее ограничение', () => {
  const result = stepPlanContext('# План\n' + 'текст '.repeat(1000), 800);
  assert.ok(result.startsWith('# План'));
  assert.ok(Buffer.byteLength(result, 'utf8') <= 800);
});
