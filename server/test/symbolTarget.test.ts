import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSymbolTargets } from '../src/exec/symbolTarget.ts';

test('bound declarations preserve case, qualified owner, range and current source identity', () => {
  const source = 'interface Envelope { id: string }\nfunction envelope() { return 1; }\nclass Store { read() { return 2; } }\nclass Cache { read() { return 3; } }';
  const [type] = describeSymbolTargets('pkg/data.ts', source, 'Envelope');
  assert.equal(type?.kind, 'interface');
  assert.equal(type?.name, 'Envelope');
  assert.ok(source.slice(type!.start,type!.end).includes('interface Envelope'));
  const [method] = describeSymbolTargets('pkg/data.ts', source, 'Cache.read');
  assert.equal(method?.qualified, 'Cache.read');
  assert.equal(method?.kind, 'method');
  assert.equal(describeSymbolTargets('pkg/data.ts', source, 'unknown').length, 0);
  assert.notEqual(describeSymbolTargets('pkg/data.ts', source + '\n', 'Envelope')[0]?.hash, type?.hash);
});
