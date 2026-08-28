/**
 * Правки по итогам ревью правок предыдущего ревью.
 *
 * Каждый тест здесь держит дефект, который РЕАЛЬНО был внесён и найден: их источник —
 * не воображение, а разбор дифа. Поэтому имена говорят про поведение, а комментарии — про
 * то, чем именно ошибались.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { computeVerdict } from '../src/verdict/verdict.ts';
import { manualClaimIds } from '../src/verdict/collect.ts';
import { parseGates } from '../src/gates/gatesFile.ts';
import { parseIterations } from '../src/run/iterationsLog.ts';
import { salvageBlocks } from '../src/run/salvage.ts';
import { destructiveOverwrite } from '../src/approval/destructive.ts';
import { countPlaceholders } from '../src/artifacts/artifact.ts';
import type { NormalizedCall, VerdictInput } from '@sdlc-runner/shared';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function input(over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    gates: [],
    claims: [],
    confirmedReviewFindings: 0,
    enabledGatesMissingFromReport: [],
    openDebtRows: [],
    brokenInvariants: [],
    regressions: [],
    plannedPathsUntouched: [],
    diffMatchesTree: true,
    attempt: 1,
    attemptBudget: 3,
    noProgress: false,
    ...over,
  };
}

const blockedGate = {
  name: 'Тесты',
  status: '⏭' as const,
  inapplicableSignedBy: null,
  envBlocked: true,
};

describe('blocked_env не отменяет остановки витка', () => {
  it('исчерпанный бюджет попыток сильнее среды', () => {
    const v = computeVerdict(input({ gates: [blockedGate], attempt: 3, attemptBudget: 3 }), []);
    strictEqual(v.action, 'escalate');
  });

  it('два одинаковых diff подряд сильнее среды', () => {
    const v = computeVerdict(input({ gates: [blockedGate], noProgress: true }), []);
    strictEqual(v.action, 'escalate');
  });

  it('патч, разошедшийся с деревом, средой не объясняется', () => {
    const v = computeVerdict(input({ gates: [blockedGate], diffMatchesTree: false }), []);
    strictEqual(v.action, 'retry');
  });

  it('регрессия рядом со средой оставляет обычный красный', () => {
    const v = computeVerdict(input({ gates: [blockedGate], regressions: ['откат кэша'] }), []);
    strictEqual(v.action, 'retry');
  });

  it('чистый случай среды по-прежнему даёт blocked_env', () => {
    const v = computeVerdict(input({ gates: [blockedGate] }), []);
    strictEqual(v.action, 'blocked_env');
  });
});

describe('пункт приёмки manual подтверждается задачей', () => {
  it('тег [manual] читается из строки приёмочного листа', () => {
    const intent = [
      '| id | Пункт | Чем проверяем |',
      '|---|---|---|',
      '| claim-1 | видно рамку | скриншот |',
      '| `claim-2 [manual]` | шрифт читаем глазами | ручной осмотр |',
      '| claim-3 [edge] | пустой ввод | тест |',
    ].join('\n');
    deepStrictEqual(manualClaimIds(intent), ['claim-2']);
  });

  it('слово manual в тексте пункта освобождением не является', () => {
    const intent = ['| claim-1 | проверяется manual-прогоном | глазами |'].join('\n');
    deepStrictEqual(manualClaimIds(intent), []);
  });
});

describe('журнал итераций', () => {
  it('blocked_env читается обратно как blocked_env, а не как retry', () => {
    const text = [
      '# Итерации',
      '',
      '| Когда | Chunk | Попытка | Исход | Совпадение с прошлым | Причины |',
      '|---|---|---|---|---|---|',
      '| 2026-08-28 | 1 | 1 | ❌ blocked_env | н/п | нет docker |',
      '',
    ].join('\n');
    const rows = parseIterations(text);
    strictEqual(rows[0]?.action, 'blocked_env');
  });
});

describe('условие возврата к принятому риску', () => {
  const gates = (how: string): string =>
    [
      '# Набор',
      '',
      '## Набор',
      '',
      '| Гейт | Вкл | Где отчитывается | Чем реализован |',
      '|---|---|---|---|',
      '| Линт экосистемы | нет | этап 6 | н/п — долг |',
      '',
      '## Долг',
      '',
      '| Гейт | Где должен стоять | Как закрывается | Дата | Кто |',
      '|---|---|---|---|---|',
      `| Линт экосистемы | этап 6 | ${how} | 2026-08-28 | Иван Петров |`,
      '',
    ].join('\n');

  it('предлог «при» условием возврата не считается', () => {
    const g = parseGates(gates('риск принят: неприменим при текущей архитектуре'));
    strictEqual(g.debt[0]?.closed, false);
  });

  it('«вернёмся, когда…» условием считается', () => {
    const g = parseGates(gates('риск принят: вернёмся, когда появится второй разработчик'));
    strictEqual(g.debt[0]?.closed, true);
  });

  it('«возврат после найма QA» условием считается', () => {
    const g = parseGates(gates('риск принят: возврат после найма QA'));
    strictEqual(g.debt[0]?.closed, true);
  });
});

describe('спасение артефакта из текста', () => {
  it('вложенный блок кода не обрезает содержимое', () => {
    const text = [
      'Файл `chunk-1-journal.md`',
      '```',
      '# Журнал',
      '```bash',
      'npm test',
      '```',
      'Итог: passed',
      '```',
    ].join('\n');
    const got = salvageBlocks(text, ['D:/x/chunk-1-journal.md']);
    ok(got[0]!.content.includes('Итог: passed'), got[0]!.content);
  });

  it('незакрытый чужой блок не съедает следующий артефакт', () => {
    const text = [
      'Пример:',
      '```ts',
      'const a = 1;',
      '',
      'Файл `chunk-1-journal.md`',
      '```',
      '# Журнал',
      '```',
    ].join('\n');
    // Первый блок закрывается ограждением артефакта — это плата за наивную разметку
    // модели; важно, что разбор не падает и не пишет мусор в файл артефакта.
    deepStrictEqual(
      salvageBlocks(text, ['D:/x/chunk-1-journal.md']).map((b) => b.path),
      [],
    );
  });
});

describe('разрушающая перезапись', () => {
  it('рост очень большого файла разрушением не считается', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-big-'));
    roots.push(root);
    const big = 'x'.repeat(4_100_000);
    writeFileSync(join(root, 'data.jsonl'), big);
    const call: NormalizedCall = { kind: 'write', path: 'data.jsonl', content: `${big}\nещё` };
    strictEqual(destructiveOverwrite(call, root), null);
  });

  it('замена очень большого файла заглушкой ловится', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-big-'));
    roots.push(root);
    writeFileSync(join(root, 'data.jsonl'), 'x'.repeat(4_100_000));
    const call: NormalizedCall = { kind: 'write', path: 'data.jsonl', content: 'пусто\n' };
    ok(destructiveOverwrite(call, root) !== null);
  });
});

describe('плейсхолдеры форм', () => {
  it('поле в ```-блоке считается, упоминание в инлайн-коде — нет', () => {
    const yaml = ['```', 'slug: ‹slug›', 'branch: ‹ветка›', '```'].join('\n');
    strictEqual(countPlaceholders(yaml), 2);
    strictEqual(countPlaceholders('гейт считает `grep -c ‹` по добавленным строкам'), 0);
  });
});
