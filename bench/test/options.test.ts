/**
 * Разбор аргументов и раскладка маршрутов.
 *
 * Тесты герметичны: ни сети, ни модели, ни файловой системы — поэтому они входят в общий
 * `npm test`. Обвязка, не проверяемая вместе с рантаймом, разъезжается с ним молча.
 */

import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OptionsError, parseArgs, rawLogWanted, resolveTurnLimits } from '../src/options.ts';
import { measuredStages } from '../src/profile.ts';

describe('лимиты ходов (resolveTurnLimits)', () => {
  const prod = { maxIterationsPerStage: 55, maxIterationsByStage: { verify: 70 } };

  it('без --max-turns — штатные лимиты конфига, а не константа разбора', () => {
    const o = parseArgs(['--model', 'x', '--all']);
    strictEqual(o.maxTurnsExplicit, false);
    deepStrictEqual(resolveTurnLimits(prod, o), { maxTurns: 55, maxTurnsExplicit: false, maxIterationsByStage: { verify: 70 } });
  });

  it('явный --max-turns действует на все этапы и снимает поэтапные потолки', () => {
    const o = parseArgs(['--model', 'x', '--all', '--max-turns', '25']);
    deepStrictEqual(resolveTurnLimits(prod, o), { maxTurns: 25, maxTurnsExplicit: true, maxIterationsByStage: {} });
  });

  it('литерал опций без maxTurnsExplicit (старые тесты) читается как «ключа не было»', () => {
    strictEqual(resolveTurnLimits(prod, { maxIterationsPerStage: 1 }).maxTurns, 55);
  });
});

describe('сырой дамп (rawLogWanted)', () => {
  it('включается для любого живого прогона, не только серии', () => {
    strictEqual(rawLogWanted(parseArgs(['--model', 'x', '--stage', 'chunk']), undefined), true);
    strictEqual(rawLogWanted(parseArgs(['--model', 'x', '--all', '--repeat', '3']), ''), true);
    strictEqual(rawLogWanted(parseArgs(['--model', 'x', '--all', '--make-snapshot', 'a']), undefined), true);
  });

  it('--no-raw-log, заданная переменная окружения и режимы без витка — не включают', () => {
    const noRaw = parseArgs(['--model', 'x', '--stage', 'chunk', '--no-raw-log']);
    strictEqual(noRaw.rawLog, false);
    strictEqual(rawLogWanted(noRaw, undefined), false);
    strictEqual(rawLogWanted(parseArgs(['--model', 'x', '--all']), 'D:/свой/каталог'), false);
    strictEqual(rawLogWanted(parseArgs(['--model', 'x', '--probe']), undefined), false);
    strictEqual(rawLogWanted(parseArgs(['--model', 'x', '--preflight']), undefined), false);
    strictEqual(rawLogWanted(parseArgs(['--dry-run']), undefined), false);
  });
});

describe('аргументы бенчмарка', () => {
  it('режим одного этапа разбирается', () => {
    const o = parseArgs(['--model', 'ollama:qwen3:8b-ctx16k', '--stage', 'chunk']);
    deepStrictEqual(o.mode, { kind: 'stage', stage: 'chunk' });
    strictEqual(o.model, 'ollama:qwen3:8b-ctx16k');
  });

  it('задача по умолчанию — oversize, --task меняет её', () => {
    strictEqual(parseArgs(['--model', 'x', '--all']).task, 'oversize');
    strictEqual(parseArgs(['--model', 'x', '--all', '--task', 'freeship']).task, 'freeship');
    throws(() => parseArgs(['--model', 'x', '--all', '--task', 'нет-такой']), /неизвестная задача/);
  });

  it('форма --ключ=значение равноправна с парой', () => {
    const pair = parseArgs(['--model', 'x', '--stage', 'plan', '--attempts', '5']);
    const eq = parseArgs(['--model=x', '--stage=plan', '--attempts=5']);
    deepStrictEqual(eq.mode, pair.mode);
    strictEqual(eq.attempts, 5);
  });

  it('слаг выводится из задачи, модели и режима, если не задан', () => {
    strictEqual(parseArgs(['--model', 'ollama:qwen3:8b', '--all']).slug, 'bench-oversize-ollama-qwen3-8b-all');
    strictEqual(
      parseArgs(['--model', 'ollama:qwen3:8b', '--all', '--task', 'freeship']).slug,
      'bench-freeship-ollama-qwen3-8b-all',
    );
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

  it('бюджет по умолчанию не ноль', () => {
    // Проверка исполнителя написана как «потрачено >= потолок», поэтому бюджет 0 исчерпан
    // до первого хода и обрывает каждый этап флоу loop с «$0.0000 из $0».
    const o = parseArgs(['--model', 'x', '--all']);
    strictEqual(o.maxBudgetUsd > 0, true);
    strictEqual(parseArgs(['--model', 'x', '--all', '--budget', '12']).maxBudgetUsd, 12);
    throws(() => parseArgs(['--model', 'x', '--all', '--budget', '0']), /больше нуля/);
  });

  it('потолки задаются в минутах и переводятся в миллисекунды', () => {
    const o = parseArgs(['--model', 'x', '--all', '--stage-timeout', '5', '--run-timeout', '90']);
    strictEqual(o.stageTimeoutMs, 300_000);
    strictEqual(o.runTimeoutMs, 5_400_000);
  });

  it('--repeat разбирается, умолчание 1, с пробой/снимком несовместим', () => {
    strictEqual(parseArgs(['--model', 'x', '--all']).repeat, 1);
    strictEqual(parseArgs(['--model', 'x', '--stage', 'chunk', '--repeat', '3']).repeat, 3);
    throws(() => parseArgs(['--model', 'x', '--probe', '--repeat', '3']), /--repeat/);
    // Нецелое отклоняется явно: floor молча превращал 0.5 в «серия выключена».
    throws(() => parseArgs(['--model', 'x', '--all', '--repeat', '0.5']), /целое/);
    throws(
      () => parseArgs(['--model', 'x', '--all', '--make-snapshot', 'a', '--repeat', '2']),
      /--repeat/,
    );
  });

  it('--preflight: самостоятельный режим без витка, режим этапа не обязателен', () => {
    const o = parseArgs(['--model', 'x', '--preflight']);
    strictEqual(o.preflightOnly, true);
    strictEqual(o.mode.kind, 'all');
    // Совместим с явным режимом: преполёт тогда сверяет измеряемые маршруты именно его.
    strictEqual(parseArgs(['--model', 'x', '--preflight', '--stage', 'chunk']).mode.kind, 'stage');
    // С пробой и сухим прогоном не сочетается — три разных «вместо витка».
    throws(() => parseArgs(['--model', 'x', '--preflight', '--probe']), /взаимоисключает/);
    throws(() => parseArgs(['--model', 'x', '--preflight', '--dry-run']), /взаимоисключает/);
    throws(() => parseArgs(['--model', 'x', '--preflight', '--repeat', '3']), /--repeat/);
  });

  it('автогейт включён по умолчанию, --no-preflight отключает', () => {
    strictEqual(parseArgs(['--model', 'x', '--all']).preflight, true);
    strictEqual(parseArgs(['--model', 'x', '--all', '--no-preflight']).preflight, false);
    // Там, где автогейта нет и без флага, --no-preflight — почти наверняка опечатка.
    throws(() => parseArgs(['--model', 'x', '--probe', '--no-preflight']), /--no-preflight/);
    throws(() => parseArgs(['--model', 'x', '--dry-run', '--no-preflight']), /--no-preflight/);
    throws(() => parseArgs(['--model', 'x', '--preflight', '--no-preflight']), /--no-preflight/);
  });

  it('снимок не задан по умолчанию', () => {
    const o = parseArgs(['--model', 'x', '--all']);
    strictEqual(o.makeSnapshot, null);
    strictEqual(o.fromSnapshot, null);
  });

  it('--make-snapshot и --from-snapshot разбираются', () => {
    strictEqual(parseArgs(['--model', 'x', '--all', '--make-snapshot', 'oversize-plan']).makeSnapshot, 'oversize-plan');
    strictEqual(parseArgs(['--model', 'x', '--stage', 'chunk', '--from-snapshot', 'oversize-plan']).fromSnapshot, 'oversize-plan');
  });

  it('--make-snapshot в тот же слот, что и --from-snapshot, — ошибка; в другой — законно', () => {
    throws(
      () => parseArgs(['--model', 'x', '--all', '--make-snapshot', 'a', '--from-snapshot', 'a']),
      /один слот/,
    );
    // Снимок от снимка: читаем «после plan», пишем «после chunk» — без повторной оплаты 1–4.
    const o = parseArgs([
      '--model', 'x', '--all',
      '--from-snapshot', 'oversize-plan',
      '--make-snapshot', 'oversize-chunk', '--snapshot-after', 'chunk',
    ]);
    strictEqual(o.fromSnapshot, 'oversize-plan');
    strictEqual(o.makeSnapshot, 'oversize-chunk');
    strictEqual(o.snapshotAfter, 'chunk');
  });

  it('точка снимка по умолчанию — plan, --snapshot-after меняет её', () => {
    strictEqual(parseArgs(['--model', 'x', '--all', '--make-snapshot', 'a']).snapshotAfter, 'plan');
    strictEqual(
      parseArgs(['--model', 'x', '--all', '--make-snapshot', 'a', '--snapshot-after', 'intent']).snapshotAfter,
      'intent',
    );
  });

  it('--snapshot-after без --make-snapshot — ошибка, а не молчаливый no-op', () => {
    throws(() => parseArgs(['--model', 'x', '--all', '--snapshot-after', 'intent']), /--make-snapshot/);
  });

  it('снимок после handoff запрещён: мерить со снимка было бы нечего', () => {
    throws(
      () => parseArgs(['--model', 'x', '--all', '--make-snapshot', 'a', '--snapshot-after', 'handoff']),
      /handoff/,
    );
  });
});

describe('сводка посевов (--seed-summary)', () => {
  it('самостоятельный режим: не требует ни модели, ни режима этапа', () => {
    const o = parseArgs(['--seed-summary']);
    strictEqual(o.seedSummary, true);
  });

  it('несовместим с ключами живого прогона, включая --model и --stage/--all (code-review-all, 2026-09-21)', () => {
    throws(() => parseArgs(['--seed-summary', '--model', 'x']), /--seed-summary несовместим/);
    throws(() => parseArgs(['--seed-summary', '--stage', 'verify']), /--seed-summary несовместим/);
    throws(() => parseArgs(['--seed-summary', '--all']), /--seed-summary несовместим/);
    throws(() => parseArgs(['--seed-summary', '--model', 'x', '--stage', 'verify']), /--seed-summary несовместим/);
    throws(() => parseArgs(['--seed-summary', '--probe']), /--seed-summary несовместим/);
    throws(() => parseArgs(['--seed-summary', '--dry-run']), /--seed-summary несовместим/);
  });
});

describe('посев (--seed)', () => {
  const base = ['--model', 'x', '--stage', 'verify', '--from-snapshot', 'snap'];

  it('ключ не задан — посева нет', () => {
    strictEqual(parseArgs(base).seed, null);
  });

  it('посев принимается вместе со снимком и --stage verify', () => {
    strictEqual(parseArgs([...base, '--seed', 'silent-price-change']).seed, 'silent-price-change');
  });

  it('контрольный прогон none не требует ни снимка, ни этапа', () => {
    strictEqual(parseArgs(['--model', 'x', '--all', '--seed', 'none']).seed, 'none');
  });

  it('неизвестный класс посева отвергается', () => {
    throws(() => parseArgs([...base, '--seed', 'нет-такого']), /неизвестный посев/);
  });

  it('без снимка посев запрещён: исполнитель этапа 5 увидел бы дефект как свой', () => {
    throws(() => parseArgs(['--model', 'x', '--stage', 'verify', '--seed', 'silent-price-change']), /--from-snapshot/);
  });

  it('вне --stage verify посев запрещён', () => {
    throws(
      () => parseArgs(['--model', 'x', '--stage', 'chunk', '--from-snapshot', 'snap', '--seed', 'silent-price-change']),
      /--stage verify/,
    );
  });

  it('посев чужой задачи отклоняется при разборе, а не на замере', () => {
    // Якорь посева — дословный текст конкретной фикстуры; на снимке другой задачи его нет,
    // и падать этим на платном прогоне — поздно.
    throws(
      () => parseArgs([...base, '--task', 'vat-rounding', '--seed', 'silent-price-change']),
      /применим только к фикстуре/,
    );
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
