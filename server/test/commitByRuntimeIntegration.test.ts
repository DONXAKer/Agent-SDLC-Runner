/**
 * `commitByRuntime` целиком — против настоящего git-репозитория, не заглушенных `git()`.
 * Специально проверяет регрессию ревью (2026-09-18): правка оператора в очереди одобрений
 * («редактировать аргументы») обязана исполниться дословно, а не быть тихо отброшенной в
 * пользу исходно вычисленного состава.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Decision, NormalizedCall, PolicyContext } from '@sdlc-runner/shared';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { commitByRuntime } from '../src/run/commitByRuntime.ts';
import type { StageHost } from '../src/run/stages/types.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

const PLAN = ['## files_to_touch', '', '| Путь | Что делаем |', '|---|---|', '| `src/a.ts` | правка |', ''].join('\n');

/** Живой git-репозиторий с одним запланированным изменённым файлом и грязным каталогом витка. */
function repo(): { root: string; paths: WitokPaths } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-commit-int-')));
  roots.push(root);
  git(['init', '-q'], root);
  git(['config', 'user.email', 'test@test'], root);
  git(['config', 'user.name', 'test'], root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'README.md'), '# demo\n');
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'init'], root);

  mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
  const paths = new WitokPaths(root, 'demo');
  writeFileSync(paths.plan, PLAN);
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n'); // изменение по плану
  writeFileSync(join(root, 'README.md'), '# demo changed\n'); // изменение ВНЕ плана
  return { root, paths };
}

/** Минимальный `StageHost`: реализует только то, что трогает `commitByRuntime`. */
function host(root: string, paths: WitokPaths, decision: Decision): StageHost {
  return {
    id: 'run-1',
    slug: 'demo',
    paths,
    projectRoot: root,
    chunk: () => 1,
    attempt: () => 1,
    syntheticRequestId: (prefix: string) => `${prefix}-1`,
    policyContext: () =>
      ({
        projectRoot: root,
        stage: 'handoff',
        sdlcDir: '.sdlc/demo',
        planFiles: null,
        protectedArtifacts: [],
        readOnlyRoots: [],
        allowedTools: [],
        mcpTools: [],
      }) as PolicyContext,
    requestApproval: async () => decision,
    limits: () => ({ gateTimeoutMs: 30_000 }) as ReturnType<StageHost['limits']>,
    aborterSignal: () => undefined,
  } as unknown as StageHost;
}

describe('commitByRuntime (интеграция)', () => {
  it('без правки оператора — коммитит предложенный состав', async () => {
    const { root, paths } = repo();
    const decision: Decision = { allowed: true, updatedInput: null, by: 'operator' };
    const outcome = await commitByRuntime(host(root, paths, decision), 'passed');
    ok(outcome.committed, outcome.note);
    const committed = execFileSync('git', ['show', '--pretty=format:', '--name-only', 'HEAD'], { cwd: root })
      .toString('utf8')
      .split(/\r?\n/)
      .filter((l) => l !== '');
    ok(committed.includes('src/a.ts'), committed.join(', '));
    ok(!committed.includes('README.md'), 'README.md вне плана не должен был попасть в коммит');
  });

  it('правка оператора в очереди одобрений исполняется ДОСЛОВНО, не исходный состав', async () => {
    const { root, paths } = repo();
    // Оператор редактирует показанную команду: коммитит ТОЛЬКО README.md (вымышленный,
    // но допустимый сценарий правки состава) вместо предложенного src/a.ts.
    const edited: Decision = {
      allowed: true,
      updatedInput: { command: 'git add -- README.md && git commit -m "правка оператора"' },
      by: 'operator',
    };
    const outcome = await commitByRuntime(host(root, paths, edited), 'passed');
    ok(outcome.committed, outcome.note);
    strictEqual(outcome.note, 'закоммичено (состав правлен оператором)');
    const committed = execFileSync('git', ['show', '--pretty=format:', '--name-only', 'HEAD'], { cwd: root })
      .toString('utf8')
      .split(/\r?\n/)
      .filter((l) => l !== '');
    deepStrictEqual(committed, ['README.md']);
  });

  it('отказ оператора — ничего не коммитится', async () => {
    const { root, paths } = repo();
    const denied: Decision = { allowed: false, reason: 'нет', by: 'operator' };
    const outcome = await commitByRuntime(host(root, paths, denied), 'passed');
    strictEqual(outcome.committed, false);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString('utf8');
    ok(status.trim() !== '', 'дерево обязано остаться грязным — коммита не было');
  });
});
