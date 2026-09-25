/**
 * Контракт ответа рецензента `verify-review-v1` (порт `review-validate.py`): статусы,
 * набор id, адресность ссылок, kind по массиву; глифы приводятся к словам. Словари сверяются
 * со схемой методологии, а собранный JSON — с её `state_contract.py validate-review`
 * (пропускается, если эталона или python нет).
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { loadConfig } from '../src/config/load.ts';
import { REVIEW_KINDS, REVIEW_SCHEMA_VERSION, REVIEW_STATUSES, extractReviewJson, parseReviewText, validateReview } from '../src/run/stages/verify/reviewValidate.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function methodologyDir(): string | null {
  const fromEnv = process.env['SDLC_METHODOLOGY_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const d = loadConfig().runner.methodologyDir;
    return typeof d === 'string' && d !== '' ? d : null;
  } catch {
    return null;
  }
}

const GOOD = {
  schema_version: REVIEW_SCHEMA_VERSION,
  claims: [
    { id: 'claim-1', status: 'passed', evidence: [{ path: 'src/a.ts', anchor: 'round' }], remediation: '' },
    { id: 'claim-2', status: '❌', evidence: [{ path: 'src/a.ts', anchor: 'границa' }], remediation: 'поправить >=' },
  ],
  findings: [{ kind: 'mismatch', summary: 'граница сдвинута', evidence: [{ path: 'src/a.ts', anchor: '>=' }] }],
  scope: [],
  invariants: [],
  regressions: [],
  retry_instruction: 'поправить >= в src/a.ts',
};
const CLAIMS = new Set(['claim-1', 'claim-2']);
const PATHS = new Set(['src/a.ts']);

describe('verify-review-v1', () => {
  it('валидный ответ нормализуется: глиф → слово, kind по массиву', () => {
    const v = validateReview(GOOD, CLAIMS, PATHS);
    deepStrictEqual(v.errors, []);
    strictEqual(v.review?.claims[1]?.status, 'failed');
    strictEqual(v.review?.findings[0]?.kind, 'mismatch');
  });

  it('fenced-блок внутри markdown разбирается; мусор — ошибка, не исключение', () => {
    const text = `## Ревью\n\nтекст\n\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\`\n`;
    strictEqual(parseReviewText(text, CLAIMS, PATHS).valid, true);
    ok('error' in extractReviewJson('готово'));
    strictEqual(parseReviewText('готово', CLAIMS, PATHS).valid, false);
  });

  it('набор id ≠ задаче, passed без evidence, чужой путь, kind не своего массива — ошибки', () => {
    const bad = {
      ...GOOD,
      claims: [{ id: 'claim-1', status: 'passed', evidence: [], remediation: '' }],
      scope: [{ kind: 'mismatch', summary: 'x', evidence: [{ path: 'src/zzz.ts', anchor: 'y' }] }],
    };
    const v = validateReview(bad, CLAIMS, PATHS);
    strictEqual(v.valid, false);
    ok(v.errors.some((e) => e.includes('набор id')), v.errors.join('; '));
    ok(v.errors.some((e) => e.includes('без единой ссылки')), v.errors.join('; '));
    ok(v.errors.some((e) => e.includes('src/zzz.ts')), v.errors.join('; '));
    ok(v.errors.some((e) => e.includes('kind «mismatch»')), v.errors.join('; '));
  });

  it('ни одна ссылка не называет путь из патча — пересказ, не разбор', () => {
    const v = validateReview({ ...GOOD, findings: [], claims: GOOD.claims.map((c) => ({ ...c, evidence: [{ path: 'intent.md', anchor: 'x' }] })) }, CLAIMS, PATHS);
    ok(v.errors.some((e) => e.includes('путь из патча')), v.errors.join('; '));
  });

  const dir = methodologyDir();
  const schemaPath = dir === null ? null : join(dir, 'implementations', 'runner-contract', 'schemas', 'verify-review-v1.schema.json');
  it('словари совпадают со схемой методологии', { skip: schemaPath === null || !existsSync(schemaPath) }, () => {
    const schema = JSON.parse(readFileSync(schemaPath!, 'utf8')) as {
      properties: { schema_version: { const: string } };
      $defs: { claim_result: { properties: { status: { enum: string[] } } }; finding: { properties: { kind: { enum: string[] } } } };
    };
    strictEqual(schema.properties.schema_version.const, REVIEW_SCHEMA_VERSION);
    deepStrictEqual([...schema.$defs.claim_result.properties.status.enum].sort(), [...REVIEW_STATUSES].sort());
    deepStrictEqual([...schema.$defs.finding.properties.kind.enum].sort(), Object.values(REVIEW_KINDS).flat().sort());
  });

  const tool = dir === null ? null : join(dir, 'implementations', 'runner-contract', 'tools', 'state_contract.py');
  const py = ['python', 'python3'].find((c) => spawnSync(c, ['--version'], { windowsHide: true }).status === 0) ?? null;
  it('state_contract.py validate-review принимает нормализованный ответ', { skip: tool === null || !existsSync(tool) || py === null }, () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-review-'));
    roots.push(root);
    const file = join(root, 'review.json');
    writeFileSync(file, JSON.stringify(validateReview(GOOD, CLAIMS, PATHS).review, null, 2), 'utf8');
    const r = spawnSync(py!, [tool!, 'validate-review', file], { encoding: 'utf8', windowsHide: true });
    strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
  });
});
