import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadReceipts, RepeatedReadError } from '../src/exec/readReceipts.ts';

test('receipts merge shown ranges and leave unseen ranges available', () => {
  const reads = new ReadReceipts(), text = 'one\ntwo\nthree\nfour';
  reads.add('lib/alpha.ts', text, 1, 2);
  reads.add('lib/alpha.ts', text, 3, 3);
  assert.equal(reads.covered('lib/alpha.ts', text, 1, 3), true);
  assert.equal(reads.covered('lib/alpha.ts', text), false);
  assert.equal(reads.duplicate('lib/alpha.ts', text, 4, 4), false);
  assert.equal(reads.duplicate('lib/alpha.ts', text, 1, 2), true);
  assert.equal(reads.duplicate('lib/alpha.ts', text, 1, 2), true);
  assert.equal(reads.duplicate('lib/alpha.ts', text, 1, 2), true);
  assert.throws(() => reads.duplicate('lib/alpha.ts', text, 1, 2), RepeatedReadError);
});

test('changed content and different paths never inherit old coverage', () => {
  const reads = new ReadReceipts();
  reads.add('other/data.py', 'first\nsecond');
  assert.equal(reads.duplicate('other/data.py', 'changed\nsecond'), false);
  assert.equal(reads.covered('elsewhere/data.py', 'first\nsecond'), false);
  reads.add('other/data.py', 'changed\nsecond', 1, 1);
  assert.equal(reads.all().length, 1);
  assert.equal(reads.all()[0]!.complete, false);
  assert.equal(reads.covered('other/data.py', 'changed\nsecond', 0, 1), false);
  assert.throws(() => reads.add('other/data.py', 'text', 2, 1), RangeError);
});
