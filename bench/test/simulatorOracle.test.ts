import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../../server/src/config/load.ts';
import { ORACLE_KNOWN_LIMITS, ORACLE_TASKS, formatOracleResult, runOracle } from '../src/simulator/oracle.ts';

/**
 * Оракул выполнимости: живой guided v5 на всех задачах стенда с заведомо верными ответами.
 * Если виток не доходит до handoff здесь — виновата не модель, а конвейер (схема, страж, гейт).
 * Образ независимой приёмки — тот же, что у `--acceptance-image` стенда.
 */
const IMAGE = process.env.ORACLE_IMAGE ?? 'node:24-alpine';

function unavailable(): string | null {
  try {
    const runner = loadConfig().runner;
    if (!existsSync(runner.skillsDir)) return `эталон методологии недоступен: ${runner.skillsDir}`;
  } catch (error) { return `эталон методологии не настроен: ${(error as Error).message.slice(0, 120)}`; }
  const docker = spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf8', timeout: 20_000 });
  if (docker.error || docker.status !== 0) return `Docker или образ ${IMAGE} недоступны — независимая приёмка не регистрируется`;
  return null;
}

test('оракул: верные ответы доводят guided v5 до handoff на каждой задаче стенда, кроме задокументированных пределов', { timeout: 30 * 60_000 }, async t => {
  const reason = unavailable();
  if (reason !== null) { t.skip(reason); return; }
  const results = await Promise.all(ORACLE_TASKS.map(task => runOracle({ task, image: IMAGE, stageTimeoutMs: 15 * 60_000, runTimeoutMs: 25 * 60_000 })));
  for (const result of results) {
    const summary = formatOracleResult(result);
    assert.deepEqual(result.unhandled, [], `${result.task}: дыры книги ответов\n${summary}`);
    assert.deepEqual(result.errors, [], `${result.task}: ошибки двойника\n${summary}`);
    const limit = ORACLE_KNOWN_LIMITS[result.task];
    if (limit === undefined) {
      assert.equal(result.reachedHandoff, true, `${result.task}: конвейер не довёл верные ответы до handoff\n${summary}`);
      assert.ok(result.hidden !== null && result.hidden.fail === 0 && result.hidden.pass === result.hidden.total,
        `${result.task}: скрытые тесты ${result.hidden?.pass}/${result.hidden?.total}\n${summary}`);
      continue;
    }
    // Предел задокументирован: виток обязан упереться ровно там. Дошёл дальше — предел снят,
    // и запись в ORACLE_KNOWN_LIMITS устарела.
    assert.equal(result.reachedHandoff, false, `${result.task}: предел снят — убери запись из ORACLE_KNOWN_LIMITS (${limit.reason.slice(0, 80)}…)\n${summary}`);
    const stoppedAt = (result.stages.find(stage => !stage.ok) ?? result.stages.at(-1))?.stage;
    assert.ok(stoppedAt !== undefined && limit.stages.includes(stoppedAt), `${result.task}: ожидалась остановка на ${limit.stages.join('/')}, а не ${stoppedAt}\n${summary}`);
  }
});
