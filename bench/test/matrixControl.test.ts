import { test } from 'node:test';
import { equal, throws, rejects } from 'node:assert/strict';
import { createServer } from 'node:http';
import { MatrixControl } from '../../tools/matrixControl.ts';

test('fail-fast closes the next launch synchronously, without a polling tick', () => {
  const control = new MatrixControl(true);
  control.complete({ id: 'a', status: 'complete', outcome: { success: false } });
  let launches = 0;
  throws(() => { control.assertMayStart(); launches++; }, /cell a/);
  equal(launches, 0);
  const measurement = new MatrixControl();
  measurement.complete({ id: 'a', status: 'complete', outcome: { success: false } });
  measurement.assertMayStart();
});

test('cancellation aborts an actual pending model-load HTTP request', async t => {
  let received!: () => void;
  const started = new Promise<void>(done => { received = done; });
  const server = createServer((_req, _res) => received());
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP listener');
  const control = new MatrixControl();
  const request = control.request(`http://127.0.0.1:${address.port}`, '/api/generate', { model: 'test' }, 300000);
  const rejected = rejects(request, /cancelled/);
  await started;
  control.cancel();
  await rejected;
  throws(() => control.assertMayStart(), /cancelled/);
});
