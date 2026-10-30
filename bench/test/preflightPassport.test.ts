import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyUsage } from '@sdlc-runner/shared';
import { capabilityPassportFileName, formatPassport, passportFromUsage } from '../src/preflightPassport.ts';

test('паспорт из Usage: секунды на решение, токены в секунду, доля reasoning', () => {
  const passport = passportFromUsage([
    { ...emptyUsage(), inputTokens: 200, outputTokens: 100, reasoningTokens: 50, durationMs: 2000 },
    { ...emptyUsage(), inputTokens: 100, outputTokens: 300, durationMs: 6000 },
    { ...emptyUsage(), inputTokens: 100, outputTokens: 0, durationMs: 500 }, // без выдачи — не проба
  ]);
  assert.deepEqual(passport, { decisions: 2, completionTokens: 400, promptTokens: 300, elapsedMs: 8000,
    secondsPerDecision: 4, tokensPerSecond: 50, reasoningShare: 0.13 });
  assert.equal(formatPassport(passport!), '4 с/решение, 50 ток/с, reasoning ≈0.13 выдачи (проб 2)');
});

test('без измеримых проб паспорта нет', () => {
  assert.equal(passportFromUsage([]), null);
  assert.equal(passportFromUsage([{ ...emptyUsage(), outputTokens: 10, durationMs: 0 }]), null);
});

test('имя файла паспорта — идентификатор модели без запрещённых символов', () => {
  assert.equal(capabilityPassportFileName('ollama:qwen3:8b-ctx16k'), 'capability-preflight-ollama-qwen3-8b-ctx16k.json');
  assert.equal(capabilityPassportFileName('lmstudio:org/model name'), 'capability-preflight-lmstudio-org-model-name.json');
});
