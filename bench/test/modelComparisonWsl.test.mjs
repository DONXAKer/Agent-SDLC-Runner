import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

test('WSL transport stays alive, preserves JSON and reports HTTP errors', {
  skip: process.platform !== 'win32' || process.env.SDLC_TEST_WSL !== '1', timeout: 30_000,
}, async () => {
  mkdirSync('.tmp', { recursive: true });
  const directory = mkdtempSync(resolve('.tmp/model-comparison-transport-'));
  const fixture = join(directory, 'server.py'), pidFile = join(directory, 'worker.pid');
  writeFileSync(fixture, `import json, threading, runpy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'OK')
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        self.send_response(422 if body.get('reject') else 200)
        self.end_headers(); self.wfile.write(json.dumps(body).encode())
server = ThreadingHTTPServer(('127.0.0.1', 30120), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
runpy.run_path('bench/model-comparison/http-worker.py', run_name='__main__')
`);
  const linux = path => relative(resolve('.'), path).replaceAll('\\', '/');
  const child = spawn('wsl.exe', ['-d', 'Ubuntu', '--', 'setsid', '--wait', 'bash',
    'bench/model-comparison/linux-job.sh', linux(pidFile), '/usr/bin/python3', linux(fixture)],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const line = await lines.next();
    assert.equal(line.done, false, stderr);
    return JSON.parse(line.value);
  };
  const request = async body => { child.stdin.write(JSON.stringify(body) + '\n'); return next(); };
  try {
    assert.equal((await next()).ready, true);
    assert.equal(child.exitCode, null, 'WSL must wait for the actual worker');
    assert.deepEqual(await request({ port: 30120, path: '/health' }), { response: { status: 200, body: 'OK' } });
    const payload = { text: '\u0442\u0435\u043a\u0441\u0442', value: false, probability: 0.125 };
    assert.deepEqual(await request({ port: 30120, path: '/score', body: payload }), { response: { status: 200, body: payload } });
    assert.deepEqual(await request({ port: 30120, path: '/score', body: { reject: true } }), { response: { status: 422, body: { reject: true } } });
    assert.match((await request({ port: 1, path: '/health' })).error, /Invalid local server destination/);
    child.stdin.end();
    assert.equal((await closed)[0], 0, stderr);
  } finally {
    if (child.exitCode === null && existsSync(pidFile)) {
      const pid = readFileSync(pidFile, 'utf8').trim();
      if (/^[1-9][0-9]*$/.test(pid)) {
        try { execFileSync('wsl.exe', ['-d', 'Ubuntu', '--', 'kill', '-TERM', '--', `-${pid}`], { stdio: 'ignore', timeout: 5000 }); } catch {}
      }
    }
    lines.return();
  }
});
