/**
 * Чистая логика интерфейса.
 *
 * Тестов в `web/` не было вовсе, и это молча означало «UI не проверяется ничем»: раздел
 * бэклога утверждал «покрыт тестами» про поверхность, где ни одного теста не существовало.
 * Компоненты здесь по-прежнему не рендерятся — раннера React в проекте нет и заводить его
 * ради этого незачем. Проверяется то, что и должно быть проверяемым: правила и форматы,
 * вынесенные из компонентов.
 *
 * Запускается тем же `node --test`, что и сервер: TypeScript Node исполняет напрямую.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ConfigInfo, RunStatus, Usage } from '@sdlc-runner/shared';

import { fmtCost, fmtDuration, fmtTokens } from '../src/lib/format.ts';
import { GATE_TONE } from '../src/lib/gateTone.ts';
import { evaluateReviewerRule } from '../src/lib/reviewerRule.ts';
import { statusLabel, statusTone } from '../src/lib/runStatus.ts';

function usage(over: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    durationMs: 0,
    ...over,
  };
}

describe('формат стоимости различает три разных нуля', () => {
  it('локальный маршрут — не «ноль», а «стоимости нет»', () => {
    strictEqual(fmtCost(usage({ costUsd: null })), 'без стоимости');
  });

  it('до первого вызова модели — «—», а не $0', () => {
    strictEqual(fmtCost(usage()), '—');
  });

  it('ноль при непустых токенах — настоящий $0, а не «расхода не было»', () => {
    // Регрессия: признак считался только по input+output, и вызов, чей расход провайдер
    // посчитал без разбивки, показывался как «—» — реальные деньги выглядели как ничто.
    strictEqual(fmtCost(usage({ cacheReadTokens: 512 })), '$0');
    strictEqual(fmtCost(usage({ inputTokens: 10, outputTokens: 5 })), '$0');
  });

  it('ненулевая стоимость печатается с четырьмя знаками', () => {
    strictEqual(fmtCost(usage({ costUsd: 0.12345, inputTokens: 1 })), '$0.1235');
  });
});

describe('формат длительности и токенов', () => {
  it('секунды и минуты, а не миллисекунды', () => {
    strictEqual(fmtDuration(920), '920 мс');
    strictEqual(fmtDuration(9_200), '9 с');
    strictEqual(fmtDuration(92_000), '1 мин 32 с');
  });

  it('тысячи сокращаются', () => {
    strictEqual(fmtTokens(999), '999');
    strictEqual(fmtTokens(1_500), '1.5K');
  });
});

describe('статус относится к ЭТАПУ, а не к витку', () => {
  const ALL: RunStatus[] = ['idle', 'running', 'awaiting', 'done', 'failed', 'cancelled'];

  it('ни одна подпись не говорит «виток завершён»', () => {
    // Виток из семи этапов после первого же успешного выглядел бы законченным.
    for (const s of ALL) {
      const l = statusLabel(s, null);
      strictEqual(/виток/i.test(l), false, `${s}: ${l}`);
      ok(l.trim() !== '', `${s}: пустая подпись`);
    }
  });

  it('отмена при живом этапе читается как «останавливается», а не «отменён»', () => {
    // Отмена ставит статус сразу, а исполнитель ещё доматывает вызов: пока эти два факта
    // рендерились независимо, строка читалась как «выполняется chunk · этап отменён».
    strictEqual(statusLabel('cancelled', 'chunk'), 'останавливается…');
    strictEqual(statusLabel('cancelled', null), 'этап отменён');
    ok(statusTone('cancelled', 'chunk').includes('amber'), 'останавливающийся виток обязан быть заметен');
  });

  it('у каждого статуса есть свой цвет', () => {
    for (const s of ALL) ok(statusTone(s, null).trim() !== '', s);
  });
});

describe('цвет статуса гейта', () => {
  it('все три статуса описаны и различимы', () => {
    const tones = new Set(Object.values(GATE_TONE));
    strictEqual(tones.size, 3, 'два статуса гейта красятся одинаково');
    ok(GATE_TONE['⏭'].includes('amber'), '⏭ роняет вердикт и не должен выглядеть нейтрально');
  });
});

describe('правило рецензента на клиенте', () => {
  const models = [
    { id: 'weak', rank: 10 },
    { id: 'mid', rank: 50 },
    { id: 'strong', rank: 90 },
  ] as unknown as ConfigInfo['models'];

  const base = { chunk: ['weak'], verify: ['mid'] };

  it('базовый профиль без правок правило не нарушает', () => {
    strictEqual(evaluateReviewerRule({ models, stages: {}, base }).broken, false);
  });

  it('поднятый ОДИН chunk до уровня базового verify ловится', () => {
    // Самый частый случай правки и ровно тот, который клиент раньше пропускал молча:
    // ранги считались только когда оператор трогал ОБА этапа.
    const v = evaluateReviewerRule({ models, stages: { chunk: 'mid' }, base });
    strictEqual(v.broken, true, 'клиент снова молчит там, где сервер откажет в старте');
    strictEqual(v.chunkRank, 50);
    strictEqual(v.verifyRank, 50);
  });

  it('поднятый chunk ниже verify правило не нарушает', () => {
    strictEqual(
      evaluateReviewerRule({ models, stages: { chunk: 'weak' }, base: { chunk: ['weak'], verify: ['strong'] } }).broken,
      false,
    );
  });

  it('сравниваются КРАЙНИЕ значения ансамбля, как на сервере', () => {
    // Слабейший рецензент против сильнейшего исполнителя: иначе ансамбль стал бы
    // способом протащить слабого рецензента рядом с сильным.
    const v = evaluateReviewerRule({
      models,
      stages: {},
      base: { chunk: ['weak', 'mid'], verify: ['strong', 'mid'] },
    });
    strictEqual(v.chunkRank, 50, 'взят не сильнейший исполнитель');
    strictEqual(v.verifyRank, 50, 'взят не слабейший рецензент');
    strictEqual(v.broken, true);
  });

  it('неизвестная модель — не повод краснеть: сравнивать нечем', () => {
    const v = evaluateReviewerRule({ models, stages: {}, base: { chunk: ['нет-такой'], verify: ['mid'] } });
    strictEqual(v.chunkRank, null);
    strictEqual(v.broken, false);
  });
});
