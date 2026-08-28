/**
 * Разбор аргументов и раскладка маршрутов.
 *
 * Тесты герметичны: ни сети, ни модели, ни файловой системы — поэтому они входят в общий
 * `npm test`. Обвязка, не проверяемая вместе с рантаймом, разъезжается с ним молча.
 */

import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OptionsError, parseArgs } from '../src/options.ts';
import { measuredStages } from '../src/profile.ts';

describe('аргументы бенчмарка', () => {
  it('режим одного этапа разбирается', () => {
    const o = parseArgs(['--model', 'ollama:qwen3:8b-ctx16k', '--stage', 'chunk']);
    deepStrictEqual(o.mode, { kind: 'stage', stage: 'chunk' });
    strictEqual(o.model, 'ollama:qwen3:8b-ctx16k');
  });

  it('форма --ключ=значение равноправна с парой', () => {
    const pair = parseArgs(['--model', 'x', '--stage', 'plan', '--attempts', '5']);
    const eq = parseArgs(['--model=x', '--stage=plan', '--attempts=5']);
    deepStrictEqual(eq.mode, pair.mode);
    strictEqual(eq.attempts, 5);
  });

  it('слаг выводится из модели и режима, если не задан', () => {
    strictEqual(parseArgs(['--model', 'ollama:qwen3:8b', '--all']).slug, 'bench-ollama-qwen3-8b-all');
  });

  it('неизвестный этап называется вместе со списком допустимых', () => {
    throws(() => parseArgs(['--model', 'x', '--stage', 'chank']), /неизвестный этап «chank»/);
  });

  it('живой прогон без модели и без режима не собирается', () => {
    throws(() => parseArgs(['--all']), /не задана измеряемая модель/);
    throws(() => parseArgs(['--model', 'x']), /не задан режим/);
  });

  it('сухой прогон модели не требует — она не будет вызвана', () => {
    strictEqual(parseArgs(['--dry-run']).dryRun, true);
  });

  it('ключу со значением нужно значение, а не следующий ключ', () => {
    throws(() => parseArgs(['--model', '--all']), /ключу --model нужно значение/);
  });

  it('потолки задаются в минутах и переводятся в миллисекунды', () => {
    const o = parseArgs(['--model', 'x', '--all', '--stage-timeout', '5', '--run-timeout', '90']);
    strictEqual(o.stageTimeoutMs, 300_000);
    strictEqual(o.runTimeoutMs, 5_400_000);
  });
});

describe('раскладка измеряемых этапов', () => {
  it('режим одного этапа измеряет ровно его', () => {
    deepStrictEqual(measuredStages({ kind: 'stage', stage: 'chunk' }), ['chunk']);
  });

  it('режим --all не измеряет verify: рецензент обязан быть строго сильнее исполнителя', () => {
    const stages = measuredStages({ kind: 'all' });
    strictEqual(stages.includes('verify'), false);
    strictEqual(stages.includes('chunk'), true);
    strictEqual(stages.length, 6);
  });
});
