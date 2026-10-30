import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyLabelRules, benchLabelRules, classifyRejectionReason, collectReplayCorpus, schemaVerdict, summarizeReplayCorpus, taskNamedPaths } from '../src/replayCorpus.ts';

const benchDir = fileURLToPath(new URL('..', import.meta.url));

const outlineSchema = {
  type: 'object', additionalProperties: false, required: ['steps'],
  properties: { steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'claims', 'dependsOn'],
    properties: { file: { type: 'string', enum: ['readme.md', 'src/a.ts'] }, claims: { type: 'array', items: { type: 'string' } }, dependsOn: { type: 'array', items: { type: 'integer' } } } } } },
};

function series(root: string, name: string, slug: string, exchanges: { seq: number; stage: string; schema: string; content: string; schemaBody?: unknown }[], events: { stage: string; questionId: string; accepted: boolean; reason: string }[], task = 'vat-rounding'): string {
  const dir = join(root, name);
  const raw = join(dir, 'raw', slug);
  const traces = join(dir, 'runs', '1-1', slug, 'traces');
  mkdirSync(raw, { recursive: true });
  mkdirSync(traces, { recursive: true });
  writeFileSync(join(dir, 'runs', '1-1', slug, 'result.json'), JSON.stringify({ run: { slug, task, model: 'ollama:test-model' } }));
  for (const exchange of exchanges) {
    writeFileSync(join(raw, `${String(exchange.seq).padStart(5, '0')}-${exchange.stage}-formFill.json`), JSON.stringify({
      seq: exchange.seq, slug, stage: exchange.stage, mode: 'formFill', model: 'test-model', status: 200,
      request: { messages: [{ role: 'system', content: 'packet' }], response_format: { type: 'json_schema', json_schema: { name: exchange.schema, schema: exchange.schemaBody ?? outlineSchema } } },
      response: JSON.stringify({ choices: [{ message: { role: 'assistant', content: exchange.content } }] }),
    }));
  }
  writeFileSync(join(traces, 'events.ndjson'), events.map(event => JSON.stringify({ type: 'question_validation', runId: 'r', ...event })).join('\n') + '\n');
  return dir;
}

describe('реплей-корпус отказов guided v5', () => {
  it('сопоставляет k-й отказ ленты с k-м обменом той же схемы и раскладывает по меткам', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-replay-'));
    try {
      const dir = series(root, 'series-a', 'slug-1', [
        { seq: 1, stage: 'plan', schema: 'guided_plan_outline', content: JSON.stringify({ steps: [{ file: 'README.md', claims: ['claim-1'], dependsOn: [] }] }) },
        { seq: 2, stage: 'plan', schema: 'guided_plan_outline', content: JSON.stringify({ steps: [{ file: 'src/a.ts', claims: ['claim-1'], dependsOn: [] }] }) },
        { seq: 3, stage: 'plan', schema: 'guided_plan_outline', content: JSON.stringify({ steps: [{ file: 'src/a.ts', claims: ['claim-1'], dependsOn: [] }] }) },
        { seq: 4, stage: 'chunk', schema: 'guided_action', content: '{"action":"patch"' },
      ], [
        { stage: 'plan', questionId: 'guided_plan_outline', accepted: false, reason: '[ { "code": "invalid_value", "path": ["steps", 0, "file"], "message": "Invalid option" } ]' },
        { stage: 'plan', questionId: 'guided_plan_outline', accepted: true, reason: 'ok' },
        { stage: 'plan', questionId: 'guided_plan_outline', accepted: false, reason: 'Error: Plan outline card 1: target is not allowed: src/vat.ts' },
        { stage: 'chunk', questionId: 'guided_action', accepted: false, reason: 'Error: A complete JSON decision is required; the response reached max_tokens' },
        { stage: 'verify', questionId: 'claim:claim-1', accepted: false, reason: 'Отказ требует rejection' },
      ]);
      const cases = collectReplayCorpus([dir]);
      strictEqual(cases.length, 4);
      // Отказ №1: ответ `README.md` против enum `readme.md` — двойник по регистру → ложный отказ рантайма.
      strictEqual(cases[0]!.seq, 1);
      strictEqual(cases[0]!.label, 'false-reject');
      ok(cases[0]!.schemaIssues.length > 0);
      // Отказ №2 пропускает принятый обмен №2 и попадает на №3: схема пройдена → содержательный валидатор.
      strictEqual(cases[1]!.seq, 3);
      strictEqual(cases[1]!.label, 'post-validator');
      strictEqual(cases[1]!.rejectionClass, 'allowlist');
      // Обрезка по max_tokens — бюджет, не суждение о смысле.
      strictEqual(cases[2]!.label, 'budget');
      strictEqual(cases[2]!.rejectionClass, 'truncated');
      // Отказ без обмена в raw/ — unjoined, а не тихая подмена.
      strictEqual(cases[3]!.label, 'unjoined');
      strictEqual(cases[3]!.seq, null);
      const summary = summarizeReplayCorpus(cases);
      strictEqual(summary.cases, 4);
      strictEqual(summary.unjoinedRejections, 1);
      deepStrictEqual(summary.bySchema, { guided_plan_outline: 2, guided_action: 1, 'claim:claim-1': 1 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('правила стенда размечают отказ allowlist по тому, назван ли путь в тексте задачи', () => {
    const rules = benchLabelRules(benchDir);
    ok(rules.length > 0, 'bench/corpus/replay/labels.json должен содержать правила');
    const base = { series: 's', slug: 'x', model: 'm', task: 'vat-rounding', stage: 'plan', schema: 'guided_plan_outline', seq: 1, rawPath: null, responseSchema: null, answer: '{}', rejectionClass: 'allowlist' as const, label: 'post-validator' as const, schemaIssues: [] };
    const taskText = () => 'Создать `src/vat.ts` и тест `test/vat.test.ts`.';
    const [named, foreign, other] = applyLabelRules([
      { ...base, reason: 'Error: Plan outline card 1: target is not allowed: src/vat.ts' },
      { ...base, reason: 'Error: Plan outline card 2: target is not allowed: test/lines.test.ts' },
      { ...base, stage: 'ask', schema: 'guided_question_resolution', rejectionClass: 'citation', reason: 'Цитата не адресует предмет вопроса' },
    ], rules, taskText);
    strictEqual(named!.label, 'false-reject');
    strictEqual(foreign!.label, 'model');
    // Без правила метка остаётся «содержательный валидатор» — не угадываем.
    strictEqual(other!.label, 'post-validator');
    deepStrictEqual([...taskNamedPaths(taskText())], ['src/vat.ts', 'test/vat.test.ts']);
  });

  it('классы причин и вердикт схемы различают бюджет, схему и нормализуемые двойники enum', () => {
    strictEqual(classifyRejectionReason('Response reached max_tokens=4096; retry with max_tokens=8192'), 'truncated');
    strictEqual(classifyRejectionReason('Decision response was rejected 3 times with the same proposalHash abc'), 'sticky');
    strictEqual(classifyRejectionReason('шаг 1: символ «x» не найден в src/a.ts'), 'symbol');
    strictEqual(classifyRejectionReason('[ { "code": "invalid_type", "path": [] } ]'), 'schema');
    const twin = schemaVerdict(outlineSchema, JSON.stringify({ steps: [{ file: './SRC/A.ts', claims: [], dependsOn: [] }] }));
    strictEqual(twin.valid, false);
    strictEqual(twin.onlyEnumTwins, true);
    const foreign = schemaVerdict(outlineSchema, JSON.stringify({ steps: [{ file: 'src/b.ts', claims: [], dependsOn: [] }] }));
    strictEqual(foreign.onlyEnumTwins, false);
    strictEqual(schemaVerdict(outlineSchema, 'not json').issues[0], 'ответ не является JSON');
    strictEqual(schemaVerdict(outlineSchema, JSON.stringify({ steps: [] })).valid, true);
  });
});
