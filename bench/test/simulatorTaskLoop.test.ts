import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptedProvider, replayProvider, textTurn, toolTurn } from '../src/simulator/scriptedProvider.ts';
import { runTaskLoopScenarios, taskLoopScenarioIds } from '../src/simulator/taskLoop.ts';
import type { ChatRequest } from '../../server/src/provider/ChatProvider.ts';

const request = (): ChatRequest => ({ model: 'fixture', messages: [{ role: 'user', content: 'Задача' }], tools: [], signal: new AbortController().signal, temperature: 0 });
test('сценарный провайдер хранит независимые снимки и никогда не отвечает успехом после конца сценария', async () => {
  const provider = new ScriptedProvider('fixture', [textTurn('ответ'), toolTurn('Read', { file_path: 'example.txt' }), new Error('injected')]);
  const input = request();
  assert.equal((await provider.chat(input)).text, 'ответ');
  input.messages.length = 0;
  assert.equal(provider.requests[0]?.messages.length, 1);
  assert.equal((await provider.chat(request())).toolCalls[0]?.name, 'Read');
  await assert.rejects(provider.chat(request()), /injected/);
  assert.equal(provider.remaining, 0);
  await assert.rejects(provider.chat(request()), /SIMULATOR_SCRIPT_EXHAUSTED/);
  assert.deepEqual(provider.errors, ['SIMULATOR_SCRIPT_EXHAUSTED']);
  assert.equal(provider.exchanges[0]?.response?.text, 'ответ');
  assert.equal(provider.exchanges[2]?.error?.message, 'injected');
  assert.equal(provider.exchanges[3]?.error?.message, 'SIMULATOR_SCRIPT_EXHAUSTED');
  assert.doesNotThrow(() => JSON.stringify(provider.exchanges));
});
test('TaskLoop симуляция проверяет реальные исполнения и различает успешную защиту от успешного продукта', async () => {
  const results = await runTaskLoopScenarios();
  assert.equal(results.length, taskLoopScenarioIds.length);
  for (const result of results) {
    assert.equal(result.passed, true, `${result.id}: ${result.errors.join('; ')}`);
    assert.ok(result.trace.some(event => (event as {kind:string}).kind === 'subprocess'));
  }
  const fabricated = results.find(r => r.id === 'task-fabricated-pass')!;
  assert.equal(fabricated.actual, 'failed');
  assert.notEqual(fabricated.actual, 'ready_for_review');
  assert.equal(results.filter(r => r.actual === 'ready_for_review').length, 2);
});
test('неизвестный сценарий не превращается в пустой успешный прогон', async () => {
  await assert.rejects(runTaskLoopScenarios(['typo']), /Неизвестные/);
});

test('replay отвечает только при точном совпадении контекста и сохраняет ошибку среды', async () => {
  const source = new ScriptedProvider('record', [textTurn('recorded')]);
  await source.chat(request());
  const replay = replayProvider('replay', source.exchanges);
  assert.equal((await replay.chat(request())).text, 'recorded');
  await assert.rejects(replay.chat(request()), /SIMULATOR_SCRIPT_EXHAUSTED/);
  for (const mutate of [
    (r: ChatRequest) => { r.messages = [{ role: 'user', content: 'Другая задача' }]; },
    (r: ChatRequest) => { r.model = 'different'; },
    (r: ChatRequest) => { r.tools = [{ name: 'Read', description: 'read', schema: {} }]; },
  ]) {
    const candidate = replayProvider('replay', [...source.exchanges, ...source.exchanges]);
    const changed = request(); mutate(changed);
    await assert.rejects(candidate.chat(changed), /SIMULATOR_REPLAY_CONTEXT_MISMATCH/);
    // Даже следующий совпадающий запрос не позволяет продолжать после расхождения истории.
    await assert.rejects(candidate.chat(request()), /SIMULATOR_REPLAY_CONTEXT_MISMATCH/);
    assert.equal(candidate.errors.length, 2);
  }
  const { ProviderEnvError } = await import('../../server/src/provider/ChatProvider.ts');
  const outage = new ScriptedProvider('record', [new ProviderEnvError('offline')]);
  await assert.rejects(outage.chat(request()), ProviderEnvError);
  await assert.rejects(replayProvider('replay', outage.exchanges).chat(request()), ProviderEnvError);
});
