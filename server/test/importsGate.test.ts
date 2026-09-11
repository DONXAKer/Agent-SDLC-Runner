/**
 * Гейт «Импорты» — относительный импорт без явного расширения `.ts` в проекте без
 * `tsconfig.json`.
 *
 * Репозиторий настоящий: гейт читает diff через `git`, а не мок — то же основание, что у
 * `untrackedGate.test.ts`.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { BUILTIN } from '../src/gates/builtin/index.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const gate = BUILTIN.get('импорты');

/** Репозиторий с одним коммитом — без него `git diff` работает, но нетипично. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-imports-'));
  roots.push(root);
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  };
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.invalid']);
  run(['config', 'user.name', 'test']);
  writeFileSync(join(root, 'money.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  run(['add', 'money.ts']);
  run(['commit', '-qm', 'первый']);
  return root;
}

async function runGate(root: string): Promise<{ status: string; lastLine: string; outputTail: string | undefined }> {
  ok(gate !== undefined, 'гейт не зарегистрирован в BUILTIN');
  const outcome = await gate({ projectRoot: root, planFiles: [], baseline: null, timeoutMs: 120_000 });
  return { status: outcome.status, lastLine: outcome.lastLine, outputTail: outcome.outputTail };
}

describe('гейт «Импорты»', () => {
  it('claim-1: новый файл с импортом без расширения — красный, путь назван', async () => {
    const root = repo();
    writeFileSync(join(root, 'oversize.ts'), "import { add } from './money';\n");
    const { status, outputTail } = await runGate(root);
    strictEqual(status, '❌');
    ok(outputTail?.includes('./money'), outputTail);
    ok(outputTail?.includes('money.ts'), outputTail);
  });

  it('claim-2: импорт с расширением — зелёный', async () => {
    const root = repo();
    writeFileSync(join(root, 'oversize.ts'), "import { add } from './money.ts';\n");
    const { status } = await runGate(root);
    strictEqual(status, '✅');
  });

  it('claim-3: импорт пакета (не относительный путь) не считается расхождением', async () => {
    const root = repo();
    writeFileSync(join(root, 'oversize.ts'), "import { z } from 'zod';\n");
    const { status } = await runGate(root);
    strictEqual(status, '✅');
  });

  it('claim-4: tsconfig.json c moduleResolution «bundler» — пропуск, резолюцию держит бандлер', async () => {
    const root = repo();
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"moduleResolution":"bundler"}}\n');
    writeFileSync(join(root, 'oversize.ts'), "import { add } from './money';\n");
    const { status, lastLine } = await runGate(root);
    strictEqual(status, '⏭');
    ok(lastLine.includes('bundler'), lastLine);
  });

  // code-review-all, 2026-09-11: раньше гейт самоотключался от одного лишь ФАКТА
  // tsconfig.json, хотя этот репозиторий держит его исключительно ради `tsc --noEmit`
  // (CLAUDE.md) — тот случай, для которого гейт и заведён. `moduleResolution: "NodeNext"`
  // (как у самого server/tsconfig.json) не подразумевает бандлер, резолюющий расширение.
  it('claim-4b: tsconfig.json без «bundler» (NodeNext, тайпчек-only) гейт не отключает', async () => {
    const root = repo();
    writeFileSync(
      join(root, 'tsconfig.json'),
      '{"compilerOptions":{"moduleResolution":"NodeNext","allowImportingTsExtensions":true}}\n',
    );
    writeFileSync(join(root, 'oversize.ts'), "import { add } from './money';\n");
    const { status, outputTail } = await runGate(root);
    strictEqual(status, '❌');
    ok(outputTail?.includes('./money'), outputTail);
  });

  it('claim-4c: пустой tsconfig.json ({}) — тоже не отключает гейт', async () => {
    const root = repo();
    writeFileSync(join(root, 'tsconfig.json'), '{}\n');
    writeFileSync(join(root, 'oversize.ts'), "import { add } from './money';\n");
    const { status } = await runGate(root);
    strictEqual(status, '❌');
  });

  it('claim-5: не git-репозиторий — пропуск, а не провал', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-imports-plain-'));
    roots.push(root);
    const { status, lastLine } = await runGate(root);
    strictEqual(status, '⏭');
    ok(lastLine.includes('не git-репозиторий'), lastLine);
  });

  it('claim-6: гейт зарегистрирован под именем строки набора', () => {
    ok(BUILTIN.has('импорты'));
  });

  // Раньше регулярка ловила только `import { x } from`, молча пропуская остальные формы —
  // живая проверка нашла ровно этот пробел (docs/model-runs.md, 2026-09-10).
  it('claim-7: дефолтный импорт без расширения — тоже красный', async () => {
    const root = repo();
    writeFileSync(join(root, 'oversize.ts'), "import add from './money';\n");
    const { status, outputTail } = await runGate(root);
    strictEqual(status, '❌');
    ok(outputTail?.includes('./money'), outputTail);
  });

  it('claim-8: namespace-импорт (`* as`) без расширения — тоже красный', async () => {
    const root = repo();
    writeFileSync(join(root, 'oversize.ts'), "import * as money from './money';\n");
    const { status } = await runGate(root);
    strictEqual(status, '❌');
  });

  it('claim-9: side-effect импорт (`import \'./x\'`, без `from`) без расширения — тоже красный', async () => {
    const root = repo();
    writeFileSync(join(root, 'oversize.ts'), "import './money';\n");
    const { status } = await runGate(root);
    strictEqual(status, '❌');
  });

  it('claim-10: сочетание дефолтного и именованного (`import add, { sub } from`) без расширения — тоже красный', async () => {
    const root = repo();
    writeFileSync(join(root, 'oversize.ts'), "import add, { sub } from './money';\n");
    const { status } = await runGate(root);
    strictEqual(status, '❌');
  });
});
