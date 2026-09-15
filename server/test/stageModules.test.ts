/**
 * Модули этапов витка (`run/stages/**`): реестр полон и в порядке витка, а файлы этапов не
 * замыкают цикл импортов.
 *
 * Цикл модулей ESM здесь не абстракция: `STAGES` читается при загрузке, и модуль этапа,
 * импортирующий фасад `run/stages.ts` или `Run.ts` как значение, получил бы `undefined` (TDZ)
 * в зависимости от того, какой файл загрузился первым.
 */

import { deepStrictEqual, ok } from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { STAGE_ORDER } from '@sdlc-runner/shared';

import { STAGES } from '../src/run/stages/index.ts';

const STAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'run', 'stages');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('реестр этапов', () => {
  it('этапы — все и в порядке витка', () => {
    deepStrictEqual(
      STAGES.map((s) => s.id),
      [...STAGE_ORDER],
    );
  });
});

describe('модули этапов не замыкают цикл импортов', () => {
  it('не импортируют фасад run/stages.ts и Run.ts как значение', () => {
    for (const file of files(STAGES_DIR)) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(STAGES_DIR, file);
      for (const m of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gms)) {
        const isType = m[1] !== undefined;
        const target = m[2] ?? '';
        ok(!/(^|\/)stages\.ts$/.test(target), `${rel}: импорт фасада ${target}`);
        ok(isType || !/(^|\/)Run\.ts$/.test(target), `${rel}: импорт Run.ts как значения`);
      }
    }
  });
});
