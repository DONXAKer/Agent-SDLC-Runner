/**
 * Адрес экрана в hash'е: F5 не должен терять открытый виток, а битая ссылка — не должна
 * приводить на пустой экран.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatHash, parseHash } from '../src/lib/hashRoute.ts';
import type { Route } from '../src/lib/hashRoute.ts';

describe('разбор и сборка адреса', () => {
  const cases: Route[] = [
    { kind: 'start' },
    { kind: 'run', runId: 'r-17c3f' },
    { kind: 'archive', project: 'myproj', slug: 'pay-412' },
  ];

  it('туда и обратно без потерь', () => {
    for (const r of cases) deepStrictEqual(parseHash(formatHash(r)), r);
  });

  it('кириллица, пробелы и слэши в сегментах переживают round-trip', () => {
    // Имя проекта и slug задаёт человек: неэкранированный слэш разрезал бы адрес и
    // «мой проект/фикс» превратилось бы в чужой маршрут.
    const r: Route = { kind: 'archive', project: 'мой проект', slug: 'фикс/оплаты' };
    deepStrictEqual(parseHash(formatHash(r)), r);
  });

  it('hash разбирается и без ведущей решётки, и с лишними слэшами', () => {
    deepStrictEqual(parseHash('/run/abc'), { kind: 'run', runId: 'abc' });
    deepStrictEqual(parseHash('#//run/abc'), { kind: 'run', runId: 'abc' });
  });
});

describe('битый адрес ведёт на стартовый экран, а не в пустоту', () => {
  it('пустой, мусорный и неполный hash', () => {
    for (const h of ['', '#', '#/', '#/чушь', '#/run', '#/run/', '#/archive/onlyproject']) {
      strictEqual(parseHash(h).kind, 'start', h);
    }
  });
});
