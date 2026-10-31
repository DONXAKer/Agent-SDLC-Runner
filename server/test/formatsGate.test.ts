/**
 * Реестр форматных линтеров и гейт «Форматы».
 *
 * Два блока проверок: чистый реестр (`fileLinterFor` по имени/расширению, инвариант
 * непересечения с `codeExt` экосистем — форматный файл не обязан попадать в модульный
 * линт) и сам гейт с честной тройкой исходов: нечего проверять → ⏭, инструмента нет →
 * ⏭, нарушения → ❌. Смешивать «инструмент не установлен» с «файл плохой» нельзя.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { match, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BUILTIN } from '../src/gates/builtin/index.ts';
import type { GateContext } from '../src/gates/builtin/index.ts';
import { CODE_EXTENSIONS } from '../src/gates/ecosystems/index.ts';
import { FILE_LINTERS, fileLinterFor } from '../src/gates/ecosystems/formats.ts';

describe('реестр форматных линтеров', () => {
  it('находится по точному имени файла без расширения', () => {
    strictEqual(fileLinterFor('Dockerfile')?.id, 'dockerfile');
    strictEqual(fileLinterFor('src/sub/Dockerfile')?.id, 'dockerfile');
  });

  it('находится по расширению в любом регистре', () => {
    strictEqual(fileLinterFor('docker-compose.yml')?.id, 'yaml');
    strictEqual(fileLinterFor('config/APP.YAML')?.id, 'yaml');
    strictEqual(fileLinterFor('README.md')?.id, 'markdown');
    strictEqual(fileLinterFor('docs/a.markdown')?.id, 'markdown');
    strictEqual(fileLinterFor('build/base.dockerfile')?.id, 'dockerfile');
  });

  it('неизвестный формат — null, а не догадка', () => {
    strictEqual(fileLinterFor('src/a.ts'), null);
    strictEqual(fileLinterFor('Makefile'), null);
    strictEqual(fileLinterFor('settings.toml'), null);
  });

  it('нативная валидация JSON: скобки и запятые', () => {
    const parse = fileLinterFor('data.json')?.parse;
    ok(parse !== undefined, 'у .json обязана быть нативная проверка');
    strictEqual(parse('{"a": [1, 2, {"b": true}]}'), null);
    strictEqual(parse('{}'), null);
    // Незакрытая скобка и потерянное значение — ошибка с позицией.
    match(parse('{"a": [1, 2}') ?? '', /position|Unexpected/i);
    match(parse('{"a": }') ?? '', /position|Unexpected/i);
    // Висячая запятая — законный JSONC (tsconfig), а не поломка.
    strictEqual(parse('{"a": 1,}'), null);
  });

  it('JSONC с комментариями и висячими запятыми — исправный файл, а не красный', () => {
    const parse = fileLinterFor('tsconfig.json')?.parse;
    ok(parse !== undefined);
    strictEqual(
      parse('{\n  // комментарий\n  "compilerOptions": {\n    "strict": true,\n  },\n}\n'),
      null,
    );
    // Строка с текстом, похожим на комментарий, — не комментарий.
    strictEqual(parse('{"url": "https://a.b/c",}'), null);
    // JSONC-терпимость не прощает настоящую поломку.
    match(parse('{\n  // комментарий\n  "a": [1,\n}') ?? '', /position|Unexpected/i);
  });

  it('не пересекается с codeExt экосистем: форматный файл не достаётся модульному линту', () => {
    // Иначе один и тот же файл проверялся бы дважды — экосистемным линтером кода и
    // форматным, с разными правилами.
    for (const linter of FILE_LINTERS) {
      for (const ext of linter.exts ?? []) {
        strictEqual(
          CODE_EXTENSIONS.has(ext),
          false,
          `${linter.id}: расширение ${ext} уже принадлежит экосистеме`,
        );
      }
    }
  });
});

/** Фикстура — git-репозиторий: список изменённых файлов даёт git. */
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-formats-')));
  for (const [name, content] of Object.entries(files)) {
    const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
    if (dir !== '') mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

function ctx(root: string): GateContext {
  return {
    projectRoot: root,
    planFiles: ['Dockerfile'],
    baseline: null,
    timeoutMs: 10_000,
  };
}

function hasTool(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('гейт форматов', () => {
  const gate = BUILTIN.get('форматы');

  it('зарегистрирован в реестре встроенных', () => {
    ok(gate !== undefined);
  });

  it('форматных файлов в изменениях нет — ⏭, а не ложный ✅', async () => {
    ok(gate !== undefined);
    const root = repo({ 'src/main.go': 'package main\n' });
    const outcome = await gate(ctx(root));
    strictEqual(outcome.status, '⏭');
    match(outcome.lastLine, /форматных файлов нет|НЕ проверялись/);
  });

  it('битый JSON — ❌ с файлом и позицией, исправный — ✅, и всё это без внешних инструментов', async () => {
    ok(gate !== undefined);
    const clean = repo({ 'config/app.json': '{"a": [1, 2]}\n' });
    strictEqual((await gate(ctx(clean))).status, '✅');

    const broken = repo({ 'config/app.json': '{"a": [1, 2\n' });
    const outcome = await gate(ctx(broken));
    strictEqual(outcome.status, '❌');
    match(outcome.lastLine, /config\/app\.json/);
    // У нативной проверки нет исхода «инструмент не найден»: файл действительно разобран.
    strictEqual(outcome.missingTool ?? null, null);
  });

  it('линтеров нет на машине — ⏭ с прямой формулировкой', async (t) => {
    ok(gate !== undefined);
    if (hasTool('yamllint') || hasTool('markdownlint') || hasTool('hadolint')) {
      t.skip('форматные линтеры установлены — случай «инструмента нет» не воспроизводится');
      return;
    }
    const root = repo({ 'compose.yml': 'services: {}\n', 'README.md': '# T\n\ntext\n' });
    const outcome = await gate(ctx(root));
    strictEqual(outcome.status, '⏭');
    match(outcome.lastLine, /не найден|НЕ проверялся/);
  });

  it('чистые файлы при установленных линтерах дают ✅, грязный markdown — ❌', async (t) => {
    ok(gate !== undefined);
    if (!hasTool('markdownlint')) {
      t.skip('markdownlint не установлен — исход проверки не воспроизводится');
      return;
    }
    const clean = repo({ 'README.md': '# T\n\ntext\n' });
    strictEqual((await gate(ctx(clean))).status, '✅');
    // MD022: заголовку нужны пустые строки вокруг.
    const dirty = repo({ 'README.md': 'text\n# T\ntext\n' });
    const outcome = await gate(ctx(dirty));
    strictEqual(outcome.status, '❌');
    match(outcome.lastLine, /MD0\d+/);
  });
});
