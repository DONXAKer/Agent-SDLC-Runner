import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function pinNodeImage(image: string): string {
  if (!image || image.startsWith('-')) throw new Error('Нужен локально установленный Docker-образ Node');
  const id = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Docker не вернул неизменяемый ID образа');
  return id;
}

/** One disposable container; no network, socket, host env, privileges or writable source/test mounts. */
export async function isolatedNode(o: {
  image: string; files: { path: string; bytes: Buffer }[]; argv: string[];
  suiteRoot?: string; timeoutMs: number; signal?: AbortSignal; trustedReporter?: boolean;
}): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; container: string }> {
  const snapshot = mkdtempSync(join(tmpdir(), 'sdlc-node-snapshot-'));
  const name = `sdlc-check-${randomUUID()}`;
  const runtime = o.trustedReporter ? mkdtempSync(join(tmpdir(), 'sdlc-test-reporter-')) : null;
  try {
    for (const file of o.files) { const target = join(snapshot, file.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, file.bytes, { mode: 0o444 }); }
    return await new Promise(resolveResult => {
      const args = ['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--user', '65534:65534', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
        '--mount', `type=bind,source=${snapshot},target=/candidate,readonly`, '--workdir', '/candidate', '--env', 'SDLC_CANDIDATE_ROOT=/candidate'];
      if (o.suiteRoot) args.push('--mount', `type=bind,source=${o.suiteRoot},target=/checks,readonly`);
      if (runtime) {
        writeFileSync(join(runtime, 'reporter.mjs'), readFileSync(new URL('./acceptanceReporter.mjs', import.meta.url)), { mode: 0o444 });
        args.push('--mount', `type=bind,source=${runtime},target=/runtime,readonly`);
      }
      args.push('--entrypoint', 'node', o.image, ...o.argv);
      const child = spawn('docker', args, { windowsHide: true, ...(o.signal ? { signal: o.signal } : {}) });
      let stdout = '', stderr = '', settled = false, timedOut = false;
      const finish = (code: number | null, extra = '') => {
        if (settled) return; settled = true; clearTimeout(timer);
        resolveResult({ code, stdout, stderr: stderr + extra, timedOut, container: name });
      };
      const kill = () => {
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => { timedOut = true; kill(); finish(null, '\nПроверка превысила timeout'); }, o.timeoutMs);
      const collect = (target: 'stdout' | 'stderr', bytes: Buffer) => {
        if (target === 'stdout') stdout += bytes.toString('utf8'); else stderr += bytes.toString('utf8');
        if (stdout.length + stderr.length > 1024 * 1024) { kill(); finish(null, '\nПревышен лимит вывода'); }
      };
      child.stdout.on('data', (bytes: Buffer) => collect('stdout', bytes)); child.stderr.on('data', (bytes: Buffer) => collect('stderr', bytes));
      child.on('error', error => { kill(); finish(null, String(error)); }); child.on('close', code => finish(code));
    });
  } finally {
    // Killing a Docker client does not stop its container. Await removal before releasing mounts.
    await new Promise<void>((done, fail) => execFile('docker', ['rm', '-f', name], { windowsHide: true, timeout: 15_000 }, (error, _stdout, stderr) => {
      if (error && !/No such container/i.test(stderr)) fail(new Error(`Не подтверждено удаление контейнера ${name}: ${stderr || error.message}`));
      else done();
    }));
    rmSync(snapshot, { recursive: true, force: true });
    if (runtime) rmSync(runtime, { recursive: true, force: true });
  }
}
