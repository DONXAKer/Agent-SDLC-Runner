import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { buildPacketProfiles, contextVerdict, formatContextFinding, loadPacketProfile, writePacketProfiles, type PacketProfile } from '../src/contextPreflight.ts';

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** Серия с одним витком: обмены с usage провайдера, без usage (оценка) и с обрезанным ответом. */
function series(): string {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-context-preflight-'));
  roots.push(root);
  const seriesDir = join(root, 'series-1');
  const cell = join(seriesDir, 'runs', '1-1', 'slug-a');
  mkdirSync(join(cell, 'traces'), { recursive: true });
  writeFileSync(join(cell, 'result.json'), JSON.stringify({ run: { task: 'demo-task', model: 'ollama:demo' } }));
  const raw = join(seriesDir, 'raw', 'slug-a');
  mkdirSync(raw, { recursive: true });
  const exchange = (seq: number, stage: string, schema: string, prompt: number | null, completion: number, finish: string, contentChars = 4000): void => {
    writeFileSync(join(raw, `0000${seq}-${stage}-decision.json`), JSON.stringify({
      ts: '2026-10-30T00:00:00.000Z', seq, slug: 'slug-a', stage, mode: 'decision', attempt: 1, provider: 'ollama', model: 'demo', status: 200, durationMs: 1,
      request: { messages: [{ role: 'system', content: 'x'.repeat(100) }, { role: 'user', content: 'y'.repeat(contentChars) }], response_format: { type: 'json_schema', json_schema: { name: schema, schema: { type: 'object' } } } },
      response: JSON.stringify({ choices: [{ finish_reason: finish, message: { content: '{}' } }], ...(prompt === null ? {} : { usage: { prompt_tokens: prompt, completion_tokens: completion } }) }),
    }));
  };
  exchange(1, 'plan', 'guided_plan_card', 9000, 400, 'stop');
  exchange(2, 'plan', 'guided_plan_card', 12000, 900, 'stop');
  exchange(3, 'plan', 'guided_plan_card', 15000, 3000, 'length'); // обрезан — в p90 ответа не идёт
  exchange(4, 'ask', 'guided_question_resolution', null, 0, 'stop', 60_000); // без usage — оценка по запросу
  return seriesDir;
}

describe('преполёт по арифметике контекста', () => {
  it('строит профиль пакетов задачи: минимум/медиана промпта, p90 полного ответа, источник чисел', () => {
    const profiles = buildPacketProfiles([series()]);
    const profile = profiles.get('demo-task');
    assert.ok(profile);
    const card = profile.packets.find(packet => packet.schema === 'guided_plan_card');
    assert.ok(card);
    assert.equal(card.minPromptTokens, 9000);
    assert.equal(card.p50PromptTokens, 12000);
    assert.equal(card.maxPromptTokens, 15000);
    assert.equal(card.samples, 3);
    assert.equal(card.completeSamples, 2, 'обрезанный ответ полным не считается');
    assert.equal(card.p90CompletionTokens, 900);
    assert.equal(card.measuredSamples, 3);
    const ask = profile.packets.find(packet => packet.schema === 'guided_question_resolution');
    assert.ok(ask);
    assert.equal(ask.measuredSamples, 0, 'без usage промпт оценивается по тексту запроса');
    assert.ok(ask.minPromptTokens > 10_000);
    assert.deepEqual(profile.builtFrom, ['series-1']);
  });

  it('судит окно той же формулой, что DecisionEngine: fail до запроса, tight при обрезке, unknown без окна', () => {
    const profile: PacketProfile = { version: 1, task: 't', builtFrom: [], builtAt: '', packets: [
      { stage: 'plan', schema: 'guided_plan_card', minPromptTokens: 15_000, p50PromptTokens: 15_000, maxPromptTokens: 15_000, p90CompletionTokens: 500, samples: 1, completeSamples: 1, measuredSamples: 1 },
      { stage: 'chunk', schema: 'guided_action', minPromptTokens: 6_000, p50PromptTokens: 9_000, maxPromptTokens: 17_000, p90CompletionTokens: 10_000, samples: 1, completeSamples: 1, measuredSamples: 1 },
      { stage: 'verify', schema: 'claim', minPromptTokens: 11_000, p50PromptTokens: 11_000, maxPromptTokens: 11_000, p90CompletionTokens: null, samples: 1, completeSamples: 0, measuredSamples: 1 },
    ] };
    const small = contextVerdict(profile, { windowFor: stage => stage === 'verify' ? undefined : 16_384, reasoning: 'none' });
    assert.equal(small.ok, false);
    assert.deepEqual(small.unknownWindow, ['verify']);
    assert.equal(small.judged, 2);
    const plan = small.findings.find(finding => finding.stage === 'plan');
    assert.equal(plan?.severity, 'fail', '16384 − 15000 − 512 = 872 < 1024 — решение не стартует');
    assert.equal(plan?.remaining, 872);
    assert.match(formatContextFinding(plan!), /окно 16384 − пакет 15000 − 512 = 872, нужно ≥1024/u);
    const chunk = small.findings.find(finding => finding.stage === 'chunk');
    assert.equal(chunk?.severity, 'tight', '9872 остатка < p90 ответа 10000 — обрезка вероятна, но старт есть');
    const large = contextVerdict(profile, { windowFor: () => 32_768 });
    assert.equal(large.ok, true);
    assert.deepEqual(large.findings, []);
    assert.equal(large.judged, 3);
    const only = contextVerdict(profile, { windowFor: () => 16_384, stages: ['chunk'] });
    assert.equal(only.ok, true, 'этап вне измеряемых не судится');
    assert.equal(only.findings[0]?.severity, 'tight');
  });

  it('пишет и читает профиль по задаче; чужая или битая запись — null', () => {
    const benchDir = mkdtempSync(join(tmpdir(), 'sdlc-context-bench-'));
    roots.push(benchDir);
    const profiles = buildPacketProfiles([series()]);
    const written = writePacketProfiles(benchDir, profiles);
    assert.equal(written.length, 1);
    assert.equal(loadPacketProfile(benchDir, 'demo-task')?.packets.length, 2);
    assert.equal(loadPacketProfile(benchDir, 'other-task'), null);
    writeFileSync(join(benchDir, 'corpus', 'packets', 'broken.json'), JSON.stringify({ version: 2, task: 'broken' }));
    assert.equal(loadPacketProfile(benchDir, 'broken'), null);
  });
});
