import { ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
/**
 * Эталон методологии — чужой каталог на машине оператора (`methodologyDir`/`skillsDir` из
 * конфига), и на другой машине его просто нет. Такие кейсы ПРОПУСКАЮТСЯ с названной
 * причиной, а не остаются вечно красными: набор, красный по умолчанию, приучает себя
 * игнорировать, и настоящая регрессия в нём не видна. Там, где эталон есть, они работают
 * как раньше. Герметичный двойник для сборки промпта — `promptEcosystem.test.ts`.
 */
function нетЭталона(dir: string): string | false {
  return existsSync(dir) ? false : `нет эталона методологии на этой машине: ${dir}`;
}


import { writeArtifact } from '../src/artifacts/artifact.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { loadConfig } from '../src/config/load.ts';
import { buildPrompt, stripFrontmatter } from '../src/prompt/build.ts';
import { stageById } from '../src/run/stages.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-prompt-')));
after(() => rmSync(root, { recursive: true, force: true }));

const paths = new WitokPaths(root, 'demo');
const ctx = { paths, chunk: 2, attempt: 3 };
const now = new Date('2026-08-16T10:00:00Z');

describe('stripFrontmatter', () => {
  it('срезает YAML-шапку скилла', () => {
    const t = '---\nname: sdlc-plan\ndescription: этап 4\n---\n\n# Тело\nтекст';
    strictEqual(stripFrontmatter(t), '# Тело\nтекст');
  });

  it('оставляет текст без шапки как есть', () => {
    strictEqual(stripFrontmatter('# Тело\nтекст'), '# Тело\nтекст');
  });

  it('не съедает тело, если шапка не закрыта', () => {
    const t = '---\nname: x\n# Тело';
    ok(stripFrontmatter(t).includes('# Тело'));
  });
});

describe('сборка промпта из эталона', { skip: нетЭталона(loadConfig().runner.skillsDir) }, () => {
  const cfg = loadConfig();

  it('тело этапа берётся с диска, а не из копии в рантайме', () => {
    writeArtifact(paths.intent, '# Задача\nтекст задачи\n');
    writeArtifact(paths.readiness, '# Готовность\nготова\n');
    writeArtifact(paths.explorationReport, '# Разведка\nнайдено\n');

    const p = buildPrompt({
      runner: cfg.runner,
      stage: stageById('plan'),
      ctx,
      flow: 'sdk',
      slug: 'demo',
      now,
    });

    // Фраза из sdlc-plan/SKILL.md эталона. Если она пропала — либо скилл переехал,
    // либо рантайм перестал его читать, и оба случая надо заметить сразу.
    ok(p.system.includes('files_to_touch'), 'в системном блоке нет тела этапа');
    ok(!p.system.includes('description: Этап 4'), 'YAML-шапка не срезана');
  });

  it('adapter объясняет отличия от интерактивной сессии', () => {
    const p = buildPrompt({
      runner: cfg.runner,
      stage: stageById('plan'),
      ctx,
      flow: 'sdk',
      slug: 'demo',
      now,
    });

    ok(p.system.includes('.sdlc/demo/'), 'не назван каталог витка');
    ok(p.system.includes('mcp__sdlc__ask_human'), 'не назван инструмент вопросов для флоу sdk');
    ok(p.system.includes('chunk: **2**'), 'не назван номер chunk’а');
    ok(p.system.includes('попытка: **3**'), 'не назван номер попытки');
    ok(p.system.includes(cfg.runner.operator), 'не назван оператор');
    ok(p.system.includes('2026-08-16'), 'не названа дата');
  });

  it('флоу loop не притворяется, что показывает всё — у sdk есть скрытый пресет', () => {
    const base = { runner: cfg.runner, stage: stageById('plan'), ctx, slug: 'demo', now };
    strictEqual(buildPrompt({ ...base, flow: 'loop' }).presetNote, null);
    ok(buildPrompt({ ...base, flow: 'sdk' }).presetNote !== null);
  });

  it('имя инструмента вопросов различается по флоу', () => {
    const base = { runner: cfg.runner, stage: stageById('plan'), ctx, slug: 'demo', now };
    const sdk = buildPrompt({ ...base, flow: 'sdk' }).tools.map((t) => t.name);
    const loop = buildPrompt({ ...base, flow: 'loop' }).tools.map((t) => t.name);
    ok(sdk.includes('mcp__sdlc__ask_human'));
    ok(loop.includes('AskHuman'));
    // Файловые инструменты называются одинаково в обоих флоу — на этом держится normalize.
    ok(sdk.includes('Write') && loop.includes('Write'));
  });

  it('входные артефакты подклеиваются целиком, а не пересказываются', () => {
    const p = buildPrompt({
      runner: cfg.runner,
      stage: stageById('plan'),
      ctx,
      flow: 'loop',
      slug: 'demo',
      now,
    });
    ok(p.user.includes('текст задачи'), 'нет содержимого intent.md');
    ok(p.user.includes('найдено'), 'нет содержимого exploration-report.md');
  });

  it('отсутствующий обязательный вход назван явно, а не замолчан', () => {
    const empty = new WitokPaths(root, 'нет-такого-витка');
    const p = buildPrompt({
      runner: cfg.runner,
      stage: stageById('plan'),
      ctx: { paths: empty, chunk: 1, attempt: 1 },
      flow: 'loop',
      slug: 'нет-такого-витка',
      now,
    });
    ok(p.user.includes('Отсутствующие входы'), p.user.slice(0, 300));
    ok(p.user.includes('Не додумывай'), p.user.slice(0, 300));
  });

  // Регрессия: журнал chunk'а подавался верификации на вход, и рецензент читал рассказ
  // исполнителя о собственной работе раньше, чем сам diff. Методология запрещает ровно это:
  // «рецензент не получает рассказ исполнителя» — он смотрит на патч и на набор гейтов.
  it('этап 6 получает артефакты, но не рассказ исполнителя', () => {
    writeArtifact(paths.intent, '# Задача\nтекст задачи\n');
    writeArtifact(paths.plan, '# План\nfiles_to_touch\n');
    writeArtifact(paths.gates, '# Набор гейтов\n');
    writeArtifact(paths.chunkDiff(2, 3), 'diff --git a/x b/x\n');
    writeArtifact(paths.chunkJournal(2), '# Журнал\nЯ всё сделал правильно, честное слово.\n');

    const p = buildPrompt({
      runner: cfg.runner,
      stage: stageById('verify'),
      ctx,
      flow: 'sdk',
      slug: 'demo',
      now,
    });

    ok(p.user.includes('diff --git'), 'патч попытки обязан быть на входе');
    ok(!p.user.includes('честное слово'), 'журнал исполнителя на вход верификации не идёт');
    ok(
      p.system.includes('sdlc-reviewer'),
      'независимый рецензент этапа 6 должен быть объявлен в промпте',
    );
  });

  // Тело этапа приходит из SKILL.md эталона, писанного для сессии с оболочкой: там модели
  // велено самой перегенерировать diff, прогнать гейты и исполнить flow-verdict.py. Здесь
  // всё это делает рантайм, а Bash на этапе нет — без вычитающего блока дешёвая модель
  // сжигает ходы на фазы, для которых у неё нет прав (замеренный класс отказа).
  it('этап 6: adapter вычитает шаги, уже сделанные рантаймом', () => {
    writeArtifact(paths.intent, '# Задача\n');
    writeArtifact(paths.plan, '# План\n');
    writeArtifact(paths.gates, '# Набор гейтов\n');
    writeArtifact(paths.chunkDiff(2, 3), 'diff --git a/x b/x\n');

    const p = buildPrompt({
      runner: cfg.runner,
      stage: stageById('verify'),
      ctx,
      flow: 'loop',
      slug: 'demo',
      now,
    });

    ok(p.system.includes('УЖЕ ВЫПОЛНЕНА рантаймом'), 'вычитающий блок обязан быть в adapter');
    ok(p.system.includes('flow-verdict.py'), 'скрипт вердикта назван как не требующий запуска');
    ok(p.system.includes('§1–§5'), 'работа модели названа явно');
  });

  it('вычитающий блок этапа 6 не протекает на другие этапы', () => {
    writeArtifact(paths.intent, '# Задача\n');
    writeArtifact(paths.plan, '# План\n');
    writeArtifact(paths.chunkJournal(2), '# Журнал\n');

    const p = buildPrompt({
      runner: cfg.runner,
      stage: stageById('chunk'),
      ctx,
      flow: 'loop',
      slug: 'demo',
      now,
    });

    ok(!p.system.includes('УЖЕ ВЫПОЛНЕНА рантаймом'));
  });
});


