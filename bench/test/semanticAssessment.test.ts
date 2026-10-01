import { strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { digest } from '../src/diagnostics.ts';
import { readSemanticAssessment } from '../src/semanticAssessment.ts';

it('оценка теряет силу при изменении результата, улик или цитаты', () => {
  const root = mkdtempSync(join(tmpdir(), 'semantic-assessment-'));
  try {
    mkdirSync(join(root, 'bench/diagnostics'), { recursive: true });
    writeFileSync(join(root, 'result.json'), '{}');
    writeFileSync(join(root, 'report.md'), 'finding');
    const record = { caseId: 'V01', resultFile: 'result.json', resultHash: digest('{}'), outcome: 'pass', rationale: 'seed found',
      evidence: [{ path: 'report.md', sha256: digest('finding'), quote: 'finding' }] };
    const save = () => writeFileSync(join(root, 'bench/diagnostics/semantic-assessments.json'), JSON.stringify({ assessments: [record] }));
    save();
    strictEqual(readSemanticAssessment(root, 'V01', 'result.json')?.outcome, 'pass');
    writeFileSync(join(root, 'result.json'), '{"changed":true}');
    strictEqual(readSemanticAssessment(root, 'V01', 'result.json'), null);
    writeFileSync(join(root, 'result.json'), '{}');
    record.evidence[0]!.quote = 'invented'; save();
    strictEqual(readSemanticAssessment(root, 'V01', 'result.json'), null);
    record.evidence[0]!.quote = 'finding'; save();
    writeFileSync(join(root, 'report.md'), 'changed');
    strictEqual(readSemanticAssessment(root, 'V01', 'result.json'), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
