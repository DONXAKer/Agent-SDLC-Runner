import test from 'node:test';
import assert from 'node:assert/strict';
import { guidedSuiteSuccess } from '../../tools/guided-suite-success.ts';

test('успех серии требует handoff, точного вердикта и всех скрытых тестов без ошибок', () => {
  const valid = { driver: { stopped: 'handoff' }, finalVerdict: { passed: true },
    hidden: { total: 2, pass: 2, fail: 0, skipped: 0, errorText: null }, honesty: [{ ok: true }, { ok: null }] };
  assert.equal(guidedSuiteSuccess(valid), true);
  for (const invalid of [null, { ...valid, driver: { stopped: 'intent' } },
    { ...valid, finalVerdict: { passed: 'true' } }, { ...valid, hidden: null },
    { ...valid, hidden: { ...valid.hidden, total: 0, pass: 0 } },
    { ...valid, hidden: { ...valid.hidden, total: '2', pass: '2' } },
    { ...valid, hidden: { ...valid.hidden, pass: 1, fail: 1 } },
    { ...valid, hidden: { ...valid.hidden, skipped: 1 } },
    { ...valid, hidden: { ...valid.hidden, errorText: 'process failed' } },
    { ...valid, honesty: [{ ok: false }] }, { ...valid, honesty: [{ ok: 'false' }] },
    { ...valid, honesty: [{ detail: 'unknown' }] },
  ]) assert.equal(guidedSuiteSuccess(invalid), false, JSON.stringify(invalid));
});
