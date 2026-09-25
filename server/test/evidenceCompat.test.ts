/**
 * Совместимость свидетельств раннера с терминальным инструментом методологии: патч, снятый
 * `attemptDiff`, и запись `evidence.json` обязаны проходить `attempt-evidence.py verify`
 * без ложных красных — `diff_matches_tree`, `patch_matches_evidence`, `tests_matches_evidence`.
 * Виток, начатый раннером, продолжается в терминале и наоборот, поэтому генератор diff'а
 * должен быть одним байт в байт.
 *
 * Пропускается, если нет python или живого репозитория методологии (`runner.local.json`).
 */

import { ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { loadConfig } from '../src/config/load.ts';
import { git } from '../src/gates/git.ts';
import { recordAttemptEvidence } from '../src/run/evidence.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Тот же источник, что у `methodologyTemplates.test.ts`: окружение, затем конфиг. */
function methodologyTool(): string | null {
  const fromEnv = process.env['SDLC_METHODOLOGY_DIR'];
  let dir: string;
  try {
    dir = fromEnv !== undefined && fromEnv !== '' ? fromEnv : loadConfig().runner.methodologyDir;
  } catch {
    return null;
  }
  if (typeof dir !== 'string' || dir === '') return null;
  const tool = join(dir, 'implementations', 'claude-code', 'skills', 'sdlc-verify', 'tools', 'attempt-evidence.py');
  return existsSync(tool) ? tool : null;
}

function python(): string | null {
  for (const cmd of ['python', 'python3']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return cmd;
  }
  return null;
}

describe('свидетельства раннера читает attempt-evidence.py методологии', () => {
  const tool = methodologyTool();
  const py = python();
  it('verify: перегенерированный diff совпал с патчем, хэши сошлись', { skip: tool === null || py === null }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-compat-'));
    roots.push(root);
    await git(['init', '-q'], root);
    await git(['config', 'user.email', 'sdlc@test'], root);
    await git(['config', 'user.name', 'sdlc'], root);
    await git(['config', 'core.autocrlf', 'false'], root);
    writeFileSync(join(root, 'a.txt'), 'one\r\ntwo\r\n', 'utf8');
    writeFileSync(join(root, 'gone.txt'), 'bye\n', 'utf8');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'кириллица.txt'), 'привет\n', 'utf8');
    await git(['add', '-A'], root);
    await git(['commit', '-q', '-m', 'base'], root);
    const base = (await git(['rev-parse', 'HEAD'], root)).stdout.trim();

    writeFileSync(join(root, 'a.txt'), 'one\r\ntwo\r\nthree\r\n', 'utf8');
    writeFileSync(join(root, 'new.txt'), 'fresh\n', 'utf8');
    writeFileSync(join(root, 'src', 'кириллица.txt'), 'привет, мир\n', 'utf8');
    rmSync(join(root, 'gone.txt'));
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plan.md'), `# План: demo\n\n- **База:** ${base}\n`, 'utf8');

    await recordAttemptEvidence({
      projectRoot: root,
      diffPath: join(dir, 'chunk-1-attempt-1-diff.patch'),
      testsPath: join(dir, 'chunk-1-attempt-1-tests.txt'),
      evidencePath: join(dir, 'chunk-1-attempt-1-evidence.json'),
      diffBefore: '',
      baseSha: base,
      gateCtx: { projectRoot: root, planFiles: [], baseline: null, timeoutMs: 5000 },
      runTests: async () => ({ status: '✅', command: 'npm test', exitCode: 0, lastLine: 'ok', envBlocked: false, output: 'ok\n' }),
      meta: { slug: 'demo', chunk: 1, attempt: 1, executorModel: 'stub' },
    });

    const r = spawnSync(py!, [tool!, 'verify', root, 'demo', '1', '1'], { encoding: 'utf8', windowsHide: true });
    const out = r.stdout ?? '';
    strictEqual(r.status, 0, `${out}\n${r.stderr ?? ''}`);
    const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as Record<string, unknown>;
    strictEqual(json['diff_matches_tree'], true, out);
    strictEqual(json['evidence_present'], true, out);
    strictEqual(json['patch_matches_evidence'], true, out);
    strictEqual(json['tests_matches_evidence'], true, out);
    ok((json['produced_by'] as string).includes('sdlc-runner'), out);
  });
});
