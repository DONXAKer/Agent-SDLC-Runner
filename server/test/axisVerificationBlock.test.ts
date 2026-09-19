/**
 * Блок «все шесть осей» во входе свободного хода рецензента (`runReviewerDirectly`) —
 * тот же приём, что трек 1а `reviewFill` (`run/reviewFill.ts`), но для маршрута,
 * которому `reviewFill` не достаётся: флоу `sdk` целиком и флоу `loop` без него.
 * Замер (`docs/model-runs.md`, «Первый посев в истории журнала»): `claude-sdk:sonnet`
 * в свободном ходе пропустил оба осевых посева при чистом контроле — план объявлял
 * ось «Ресурсы и скорость» и смежные незатронутыми либо покрытыми чужим claim'ом, и
 * рецензент перенёс это как факт, diff не сверив.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { axisVerificationBlock } from '../src/run/stages/verify/reviewer.ts';

describe('axisVerificationBlock', () => {
  it('плана нет — блока нет', () => {
    strictEqual(axisVerificationBlock(null), null);
  });

  it('называет все шесть осей канона, даже если план назвал только одну', () => {
    const plan = [
      '## Последствия шагов',
      '',
      '| Ось | Затронута | Исход |',
      '|---|---|---|',
      '| Безопасность | нет | н/п — не затрагивает |',
    ].join('\n');
    const block = axisVerificationBlock(plan)!;
    ok(block !== null);
    for (const name of [
      'Безопасность',
      'Ресурсы и скорость',
      'Отказы зависимостей',
      'Настройки',
      'Совместимость и данные',
      'Наблюдаемость',
    ]) {
      ok(block.includes(`«${name}»`), `нет оси «${name}» в блоке:\n${block}`);
    }
  });

  it('ось «не затронута» по плану — явно названа как заявление, требующее проверки', () => {
    const plan = [
      '## Последствия шагов',
      '',
      '| Ось | Затронута | Исход |',
      '|---|---|---|',
      '| Настройки | нет | н/п — переменных окружения не добавляли |',
    ].join('\n');
    const block = axisVerificationBlock(plan)!;
    const line = block.split('\n').find((l) => l.includes('«Настройки»'));
    ok(line !== undefined);
    ok(line!.includes('НЕ затронутой'), line);
    ok(block.includes('сверь с diff'), 'блок обязан требовать сверки с diff, а не пересказа плана');
  });

  it('ось «затронута» по плану — тоже требует сверки заявленного исхода, а не молчаливого доверия', () => {
    const plan = [
      '## Последствия шагов',
      '',
      '| Ось | Затронута | Исход |',
      '|---|---|---|',
      '| Настройки | да | claim-3 |',
    ].join('\n');
    const block = axisVerificationBlock(plan)!;
    const line = block.split('\n').find((l) => l.includes('«Настройки»'));
    ok(line !== undefined);
    ok(line!.includes('ЗАТРОНУТОЙ'), line);
    ok(line!.includes('claim-3'), line);
  });

  it('строки для оси в плане нет вовсе — честно сказано «в плане строки нет», а не «не затронута»', () => {
    const plan = ['## Последствия шагов', '', '| Ось | Затронута | Исход |', '|---|---|---|'].join('\n');
    const block = axisVerificationBlock(plan)!;
    const line = block.split('\n').find((l) => l.includes('«Наблюдаемость»'));
    ok(line !== undefined);
    ok(line!.includes('в плане строки нет'), line);
  });

  it('подсказка оси (AXIS_HINTS) присутствует рядом с именем — та же подсказка, что у reviewFill', () => {
    const plan = [
      '## Последствия шагов',
      '',
      '| Ось | Затронута | Исход |',
      '|---|---|---|',
      '| Безопасность | нет | н/п |',
    ].join('\n');
    const block = axisVerificationBlock(plan)!;
    ok(block.includes('секреты'), 'подсказка оси «Безопасность» обязана упомянуть секреты');
  });

  it('две строки на одну ось — побеждает ПОСЛЕДНЯЯ (актуальная), не первая (устаревшая)', () => {
    // Регрессия ревью (2026-09-18): повторная правка плана вручную или `applyAxisAnswers`
    // поверх старой таблицы может оставить строку той же оси дважды — устаревшую выше,
    // исправленную ниже. Дедуп по первому вхождению отдавал рецензенту устаревший статус
    // ровно там, где блок должен снимать доверие к тексту плана, а не добавлять новое.
    const plan = [
      '## Последствия шагов',
      '',
      '| Ось | Затронута | Исход |',
      '|---|---|---|',
      '| Настройки | нет | н/п — устаревшая строка |',
      '| Настройки | да | claim-3 — исправленная строка |',
    ].join('\n');
    const block = axisVerificationBlock(plan)!;
    const line = block.split('\n').find((l) => l.includes('«Настройки»'));
    ok(line !== undefined);
    ok(line!.includes('ЗАТРОНУТОЙ'), line);
    ok(line!.includes('claim-3'), line);
    ok(!line!.includes('устаревшая строка'), line);
  });
});
