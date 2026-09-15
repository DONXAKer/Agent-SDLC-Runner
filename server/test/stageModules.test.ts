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

describe('runStage не ветвится по имени этапа', () => {
  // Отличие этапа в рантайме — хук его модуля (`StageInvocation`), а не `stage === '…'` в общем
  // каркасе: иначе логика этапа снова расползается по `Run.ts`, и изучить этап в одном файле
  // нельзя. Комментарии не в счёт — в них история прежних ветвлений законна.
  it('в runStage и finishFormArtifact нет сравнений stage с литералом', () => {
    const text = readFileSync(join(STAGES_DIR, '..', 'Run.ts'), 'utf8');
    for (const head of ['  async runStage(', '  private async finishFormArtifact(']) {
      const start = text.indexOf(head);
      ok(start >= 0, `в Run.ts нет ${head.trim()}`);
      const end = text.indexOf('\n  }\n', start);
      ok(end > start, `не найден конец ${head.trim()}`);
      const code = text
        .slice(start, end)
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
        .join('\n');
      ok(!/\bstage\s*[!=]==\s*'/.test(code), `${head.trim()}: ветвление по имени этапа — место хуку модуля`);
    }
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
