/**
 * Образец граничного пункта из примера методологии (`artifacts/edgeExample.ts`).
 *
 * Замер 2026-09-04: просьба к модели называла только ФОРМАТ строки, и приёмочный лист
 * приходил с нулём `[edge]` в четырёх прогонах из пяти. Образец берётся из эталона в
 * рантайме — копий текстов методологии в репозитории нет и заводить их нельзя, поэтому
 * тест строит свой каталог-эталон, а отдельным кейсом проверяется настоящий (если есть).
 */

import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { edgeExampleLines, edgeExampleRow } from '../src/artifacts/edgeExample.ts';

const root = mkdtempSync(join(tmpdir(), 'sdlc-edge-example-'));
after(() => rmSync(root, { recursive: true, force: true }));

function methodology(name: string, intent: string | null): string {
  const dir = join(root, name);
  if (intent !== null) {
    mkdirSync(join(dir, 'example'), { recursive: true });
    writeFileSync(join(dir, 'example', 'intent.md'), intent, 'utf8');
  }
  return dir;
}

const FULL = [
  '# Задача: demo',
  '',
  '## Что делаем',
  '| claim-0 | `[edge]` строка не из листа приёмки | не должна попасть в образец |',
  '',
  '## Приёмочный лист',
  '_Граничные и негативные случаи помечаются тегом `[edge]`._',
  '',
  '| id | Пункт | Как проверить |',
  '|----|-------|---------------|',
  '| claim-1 | Обычный запрос возвращает 200 | `IT.ok` — критерий: код ровно 200 |',
  '| claim-2 | `[edge]` Запрос без заголовка не пишет ключей | `IT.noKey` — критерий: число строк не изменилось |',
  '| claim-3 | `[edge]` Тот же ключ с другим телом возвращает 409 | `IT.conflict` — критерий: код ровно 409 |',
  '',
  '## Инварианты',
  '',
].join('\n');

describe('edgeExampleRow: строка-образец из примера эталона', () => {
  it('берёт первый [edge]-пункт ИЗ СЕКЦИИ приёмочного листа, а не первый по файлу', () => {
    const row = edgeExampleRow(methodology('full', FULL));
    // claim-0 лежит выше и тоже с тегом — но он не из листа приёмки.
    match(row ?? '', /claim-2/);
    ok(!(row ?? '').includes('claim-0'));
  });

  it('пропускает счастливые пути: claim-1 идёт раньше, но он без тега', () => {
    const row = edgeExampleRow(methodology('full2', FULL));
    ok(!(row ?? '').includes('claim-1 |'));
  });

  it('незаполненный образец шаблона граничным пунктом не считается', () => {
    const text = [
      '## Приёмочный лист',
      '',
      '| claim-1 | `[edge]` ‹наблюдаемое поведение› | ‹процедура и критерий› |',
      '',
    ].join('\n');
    strictEqual(edgeExampleRow(methodology('placeholder', text)), null);
  });

  it('слишком длинная строка в образец не идёт — карточка поля не должна распухнуть', () => {
    const text = ['## Приёмочный лист', '', `| claim-1 | \`[edge]\` ${'я'.repeat(500)} | как |`, ''].join('\n');
    strictEqual(edgeExampleRow(methodology('long', text)), null);
  });

  it('нет эталона, нет секции, нет [edge] — null, а не бросок', () => {
    strictEqual(edgeExampleRow(methodology('missing', null)), null);
    strictEqual(edgeExampleRow(methodology('nosection', '# Пусто\n')), null);
    strictEqual(
      edgeExampleRow(methodology('noedge', '## Приёмочный лист\n\n| claim-1 | обычный | как |\n')),
      null,
    );
  });
});

describe('edgeExampleLines: блок для промпта', () => {
  it('без примера — пустой список: вызывающий подставляет его без условий у себя', () => {
    deepStrictEqual(edgeExampleLines(methodology('none', null)), []);
  });

  it('с примером — образец в заборе и оговорка «мысли, а не содержания»', () => {
    const lines = edgeExampleLines(methodology('full3', FULL));
    ok(lines.some((l) => l.includes('claim-2')), 'сама строка-образец');
    ok(lines.some((l) => l.includes('образец МЫСЛИ')), 'оговорка обязательна: иначе модель скопирует чужой пункт');
    strictEqual(lines.filter((l) => l === '```').length, 2, 'забор открыт и закрыт');
  });

  it('нормы («не меньше двух») блок не называет — число живёт в тексте этапа', () => {
    const lines = edgeExampleLines(methodology('full4', FULL));
    ok(!lines.join('\n').includes('не меньше'));
  });
});

describe('настоящий эталон методологии', () => {
  const dir = process.env['SDLC_METHODOLOGY_DIR'];
  const has = dir !== undefined && existsSync(join(dir, 'example', 'intent.md'));

  it(
    'в example/intent.md эталона есть годный [edge]-пункт',
    { skip: has ? false : 'эталон методологии недоступен (SDLC_METHODOLOGY_DIR)' },
    () => {
      const row = edgeExampleRow(dir as string);
      ok(row !== null, 'иначе образец в промпт не попадёт и правка молча не работает');
      ok((row ?? '').includes('[edge]'));
    },
  );
});
