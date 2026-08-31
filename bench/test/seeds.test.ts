import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { GateRunResult } from '@sdlc-runner/shared';

import { SEEDS, SEED_NONE, SeedError, applySeed, probeNoSeed, probeSeed, seedById, seedIds } from '../src/seeds.ts';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixture');

function gate(name: string, status: GateRunResult['status']): GateRunResult {
  return {
    name,
    status,
    command: 'echo',
    exitCode: status === '✅' ? 0 : 1,
    durationMs: 1,
    lastLine: '',
    envBlocked: false,
  };
}

function workspace(): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-seed-test-'));
  cpSync(FIXTURE_DIR, root, { recursive: true });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe('посев: якоря', () => {
  // Главный тест стенда. Посев держится на дословном тексте фикстуры, и если фикстуру
  // правят, якорь молча перестаёт находиться — прогон упадёт уже на дорогом замере, а
  // выглядеть будет как «модель ничего не нашла». Здесь это ловится набором.
  it('каждый якорь встречается в своём файле фикстуры ровно один раз', () => {
    for (const seed of SEEDS) {
      const text = readFileSync(join(FIXTURE_DIR, seed.file), 'utf8');
      strictEqual(text.split(seed.find).length - 1, 1, `посев ${seed.id}: якорь в ${seed.file}`);
    }
  });

  it('замена действительно меняет текст', () => {
    for (const seed of SEEDS) {
      ok(seed.find !== seed.replace, `посев ${seed.id}`);
    }
  });

  it('идентификаторы уникальны, none среди них зарезервирован', () => {
    const ids = SEEDS.map((s) => s.id);
    strictEqual(new Set(ids).size, ids.length);
    ok(!ids.includes(SEED_NONE));
    deepStrictEqual(seedIds()[0], SEED_NONE);
  });
});

describe('посев: внесение', () => {
  it('вносит дефект в рабочую копию', () => {
    const ws = workspace();
    try {
      const seed = seedById('silent-price-change');
      applySeed(ws.root, seed);
      const text = readFileSync(join(ws.root, seed.file), 'utf8');
      ok(text.includes('62_000, // свыше 5 кг'));
      ok(!text.includes('62_900, // свыше 5 кг'));
    } finally {
      ws.dispose();
    }
  });

  it('якоря нет — исключение, а не тихий пропуск', () => {
    const ws = workspace();
    try {
      const seed = seedById('silent-price-change');
      applySeed(ws.root, seed);
      // Второе внесение того же посева: якорь уже заменён — повтор обязан упасть, иначе
      // прогон пошёл бы без дефекта и «рецензент ничего не нашёл» было бы правдой о нас.
      throws(() => applySeed(ws.root, seed), SeedError);
    } finally {
      ws.dispose();
    }
  });

  it('файла нет — исключение', () => {
    const ws = workspace();
    try {
      rmSync(join(ws.root, 'src', 'tariffs.ts'));
      throws(() => applySeed(ws.root, seedById('silent-price-change')), SeedError);
    } finally {
      ws.dispose();
    }
  });

  it('неизвестный посев не собирается', () => {
    throws(() => seedById('нет-такого'), SeedError);
  });
});

describe('посев: щуп находимости', () => {
  const seed = seedById('swallow-tariff-error');

  it('дефект назван в отчёте — пойман отчётом', () => {
    const p = probeSeed({
      reportText: 'В `basePrice` исключение заменено возвратом первой ступени — цена клиенту чужая.',
      seed,
      verdictReasons: null,
      gateResults: [gate('Тесты', '✅')],
    });
    strictEqual(p.caught, true);
    deepStrictEqual(p.where, ['report']);
  });

  it('находка ревью из причин вердикта тоже считается', () => {
    const p = probeSeed({
      seed,
      reportText: '',
      verdictReasons: ['нарушен инвариант: тариф не заполнен больше не бросает ошибку'],
      gateResults: [],
    });
    strictEqual(p.caught, true);
  });

  it('красный ЧУЖОЙ гейт поимкой не считается', () => {
    // Посев класса review автоматике не виден. Засчитывать ему красный scope значило бы
    // записать модели чужую находку — ровно тот способ получить бодрый замер на пустом месте.
    const p = probeSeed({
      seed,
      reportText: 'расхождений не найдено',
      verdictReasons: ['гейт «Scope: файлы вне плана» провалился (❌)'],
      gateResults: [gate('Scope: файлы вне плана', '❌')],
    });
    strictEqual(p.caught, false);
    deepStrictEqual(p.where, []);
  });

  it('контрольный посев засчитывается своим гейтом', () => {
    const control = seedById('weight-step-off-by-one');
    const p = probeSeed({
      seed: control,
      reportText: '',
      verdictReasons: null,
      gateResults: [gate('Тесты', '❌'), gate('Сборка', '✅')],
    });
    strictEqual(p.caught, true);
    deepStrictEqual(p.where, ['gate']);
  });

  it('имя гейта сверяется нормализованно', () => {
    const control = seedById('skip-existing-test');
    const p = probeSeed({
      seed: control,
      reportText: '',
      verdictReasons: null,
      gateResults: [gate('`Анти-обход тест-гейта`', '❌')],
    });
    strictEqual(p.caught, true);
  });
});

describe('посев: контрольный прогон без посева', () => {
  it('чисто — ложных срабатываний нет', () => {
    const p = probeNoSeed({ verdictReasons: ['пункт приёмки claim-9 не проверяем (⚠)'], gateResults: [gate('Тесты', '✅')] });
    strictEqual(p.caught, false);
    strictEqual(p.seedId, SEED_NONE);
  });

  it('найденная «регрессия» на чистом сэмпле — ложное срабатывание', () => {
    const p = probeNoSeed({
      verdictReasons: ['регрессия — откат ранее работавшего поведения: цена дальней зоны'],
      gateResults: [],
    });
    strictEqual(p.caught, true);
    deepStrictEqual(p.where, ['report']);
  });
});
