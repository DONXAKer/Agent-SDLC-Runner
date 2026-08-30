/**
 * Сборка промпта этапа.
 *
 * Тело этапа — содержимое `SKILL.md` эталона, прочитанное с диска в рантайме. Мы его не
 * копируем: эталон остаётся единственным источником правды, и правка методологии доезжает
 * сюда без релиза рантайма.
 *
 * Промпт уходит в шину событием `prompt_prepared` ДО вызова исполнителя, и оператор может
 * его отредактировать. Поэтому здесь не должно быть ничего, что подмешивается позже и
 * незаметно: всё, что уйдёт в модель, собрано в этой функции.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { placeholderRanges, readArtifact } from '../artifacts/artifact.ts';
import { extractHumanFacts } from '../artifacts/humanFacts.ts';
import type { RunnerConfig } from '../config/schema.ts';
import { specsFor } from '../exec/toolSpecs.ts';
import { toPosix } from '../policy/paths.ts';
import type { StageContext, StageDef } from '../run/stages.ts';
import { stageInputs } from '../run/stages.ts';
import type { FlowId, PreparedPrompt, ToolName } from '@sdlc-runner/shared';

const MAX_ARTIFACT_BYTES = 40_000;

/**
 * Свой потолок входного артефакта для ЭТАПОВ-ДОКУМЕНТОВ флоу `loop`.
 *
 * Общие 40 000 рассчитаны на модель с большим окном. Локальный контур живёт на 16K
 * токенов, и один план на 40 КБ съедает окно ЦЕЛИКОМ ещё до истории цикла — измерено:
 * этап intent на локальной модели набирал 314k входных токенов за ~30 ходов именно из-за
 * входов, повторяемых каждым запросом. Обрезка честная — с пометкой в тексте.
 *
 * На chunk/verify/handoff потолок НЕ действует: их вход — diff и улики, и рецензент,
 * получивший первую треть диффа, вынес бы вердикт, не увидев ни удалённого теста, ни
 * внесённого секрета. Лучше промпт не влез, чем вердикт по трети правки.
 *
 * Байты, не `length`: кириллица в UTF-8 — 2 байта на символ, и посимвольный потолок
 * пропускал вдвое больше задуманного (тот же урок, что у `cap()` в exec/tools).
 */
const LOOP_MAX_ARTIFACT_BYTES = 12_000;
const LOOP_CAPPED_STAGES: ReadonlySet<string> = new Set(['intent', 'explore', 'ask', 'plan']);

/** Обрезка по БАЙТАМ с выравниванием по границе символа. */
function capBytes(text: string, maxBytes: number): { text: string; capped: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, capped: false };
  let cut = text.slice(0, maxBytes); // символов не больше, чем байтов — стартовая оценка сверху
  while (Buffer.byteLength(cut, 'utf8') > maxBytes) {
    cut = cut.slice(0, Math.floor((cut.length * maxBytes) / Buffer.byteLength(cut, 'utf8')));
  }
  return { text: cut, capped: true };
}

export interface BuildPromptInput {
  runner: RunnerConfig;
  stage: StageDef;
  ctx: StageContext;
  flow: FlowId;
  slug: string;
  /**
   * Эффективный набор инструментов этапа, если он отличается от `stage.tools`:
   * урезание `leanTools` считает рантайм (`Run.toolsFor`), и промпт обязан показывать
   * ровно тот список, с которым уйдёт запрос, — иначе панель промпта врёт оператору.
   */
  tools?: readonly ToolName[];
  /** Формулировка задачи от человека — только на этапе 1, где артефакта ещё нет. */
  requirement?: string;
  /** `retry_instruction` и `carry_forward` при возврате с этапа 6, и подобное. */
  extra?: string;
  /**
   * Что рантайм УВИДЕЛ в дереве проекта: чем он собирается и чем прогоняются тесты.
   *
   * Заполняет вызывающий из того же источника, что и гейты (профиль проекта, иначе
   * автодетект): второй детект внутри сборки промпта означал бы два знания об одном, и
   * рано или поздно они разошлись бы. Не определилось — поле не задаётся, и блок молчит:
   * модель, которой сказали «сборка: npm run build» в проекте без package.json, потратит
   * итерацию на починку несуществующей поломки.
   */
  /**
   * Набор MCP-инструментов, выданный этапу. Считается вызывающим до сборки промпта: два
   * места, считающих набор, показали бы оператору не то, что уходит в модель.
   */
  mcpTools?: readonly { name: string; description: string; schema: Record<string, unknown> }[];
  /**
   * Серверы, которые не ответили. Про них говорится ПРЯМО: недоступный редактор, о котором
   * промолчали, превращается в выдуманный отчёт «сделано» — тот самый ложный зелёный,
   * от которого весь этот сервис и защищается.
   */
  mcpUnavailable?: readonly { name: string; reason: string }[];
  /**
   * Артефакты, под которые рантайм уже разложил формы. Сказать об этом обязательно: файл,
   * появившийся сам собой, модель иначе принимает за чужую работу и либо не трогает его,
   * либо начинает сочинять структуру рядом.
   */
  seededArtifacts?: readonly string[];
  ecosystem?: readonly {
    /** Каталог модуля относительно корня проекта. `.` — корень. */
    dir: string;
    label: string;
    /** `null` — у языка нет шага сборки; гейт проверяет синтаксис изменённых файлов. */
    build: string | null;
    test: string | null;
  }[];
  now: Date;
}

export function readSkillBody(skillsDir: string, skill: string): string {
  const file = join(skillsDir, skill, 'SKILL.md');
  if (!existsSync(file)) {
    throw new Error(
      `не найден текст этапа: ${file}\n` +
        `Рантайм читает этапы из эталона методологии, а не хранит свои копии. ` +
        `Проверь skillsDir в config/runner.json.`,
    );
  }
  return stripFrontmatter(readFileSync(file, 'utf8'));
}

/** YAML-шапка скилла — метаданные для Claude Code, модели она не нужна. */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text.trim();
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text.trim();
  const nl = text.indexOf('\n', end + 1);
  return (nl < 0 ? '' : text.slice(nl + 1)).trim();
}

/**
 * Блок, объясняющий модели, чем этот прогон отличается от интерактивной сессии Claude Code,
 * под которую написан SKILL.md. Всё, что здесь сказано, обеспечено конструкцией рантайма —
 * это описание поведения, а не просьба.
 */
function adapterBlock(i: BuildPromptInput): string {
  const sdlcDir = `.sdlc/${i.slug}`;
  const templates = toPosix(join(i.runner.methodologyDir, 'templates'));
  const date = i.now.toISOString().slice(0, 10);

  const askTool = i.flow === 'sdk' ? 'mcp__sdlc__ask_human' : 'AskHuman';

  const lines = [
    '## Как этот этап исполняется здесь',
    '',
    'Ты работаешь внутри Agent-SDLC Runner, а не в интерактивной сессии Claude Code.',
    'Текст этапа выше — эталонный; ниже отличия, которые надо учесть.',
    '',
    `- Slug витка: \`${i.slug}\`. Артефакты витка: \`${sdlcDir}/\`, набор гейтов: \`.sdlc/gates.md\`.`,
    `- Формы артефактов лежат в \`${templates}\` — это каталог МЕТОДОЛОГИИ, он открыт только ` +
      `на чтение. Артефакты витка пишутся в \`${sdlcDir}/\` и больше никуда: копировать формы ` +
      'в проект не надо, читай их на месте.',
    ...((i.seededArtifacts ?? []).length > 0
      ? [
          `- Формы уже разложены по местам: ${(i.seededArtifacts ?? []).join(', ')}. Это пустые ` +
            'бланки, а не чужая работа: открой и заполни поля прямо в них, вместо `‹…›` — ' +
            'своё содержимое. Создавать документ заново не нужно.',
        ]
      : []),
    `- Вместо \`AskUserQuestion\` вызывай \`${askTool}\`: этап встаёт на паузу, пока человек не ` +
      'ответит в интерфейсе. Правила те же — до 4 вопросов за вызов, блокирующие первыми, ' +
      'один вопрос это одна неопределённость, у каждого варианта в описании названа цена ошибки.',
    `- Вместо \`ExitPlanMode\` бери одобрение тем же \`${askTool}\`.`,
    '- Решение человека записывай полем в артефакт: молчание одобрением не считается, ' +
      'а одобрение, оставшееся в переписке, для следующего этапа не существует.',
    `- Оператор: **${i.runner.operator}**. Сегодня: **${date}**. Эти значения подставляй в поля решений.`,
    `- Текущий chunk: **${i.ctx.chunk}**, попытка: **${i.ctx.attempt}**.`,
    `- Доступные инструменты на этом этапе: ${(i.tools ?? i.stage.tools).join(', ')}. Других у тебя нет — ` +
      'права выдаются на шаг, а не на прогон.',
    // Few-shot только для флоу loop: замеры (`docs/model-runs.md`) показали, что локальная
    // модель печатает содержимое файла текстом вместо вызова Write/Edit — на всех
    // замеренных моделях именно здесь ход и сгорал. Пример корректного вызова снижает
    // порог «дойти до инструмента»; сильной модели флоу sdk он не нужен и только ест окно.
    ...(i.flow === 'loop' ? fewShotLines(i) : []),
    ...((i.mcpTools ?? []).length > 0
      ? [
          `- Инструменты внешних MCP-серверов на этом этапе: ` +
            `${(i.mcpTools ?? []).map((t) => t.name).join(', ')}. Набор ограничен намеренно: ` +
            'описания сотен инструментов не помещаются в контекст. Нужного нет — так и напиши ' +
            'в артефакте, а не подбирай похожий.',
        ]
      : []),
    ...((i.mcpUnavailable ?? []).map(
      (s) =>
        `- MCP-сервер \`${s.name}\` НЕДОСТУПЕН: ${s.reason}. Задачи, требующие его ` +
        'инструментов, выполнить нельзя — напиши это в артефакте прямо, не изображай ' +
        'выполнение и не выдумывай результат.',
    ) ?? []),
    ...(i.stage.subagents.length > 0
      ? [
          `- Субагенты этого этапа: ${i.stage.subagents.join(', ')} — вызывай их инструментом ` +
            '`Task`, поле `subagent_type`. Их права заданы конструкцией, а не просьбой: ' +
            'разведчик места правки не имеет инструментов записи, рецензент не получает ' +
            'твой рассказ о работе.',
        ]
      : []),
    '- Запись вне `files_to_touch` одобренного плана отклоняется в момент вызова. Это ' +
      'конструкция, а не сбой: если файл действительно нужен, его сначала добавляют в план — ' +
      'инструментом `RequestScopeExtension` (если он тебе доступен), а не молчаливой попыткой ' +
      'записи или остановкой chunk\'а на середине.',
    '- Решения человека и набор гейтов защищены от записи на этом этапе: одобренный план ' +
      'правит человек, а не ты. Нужна правка плана — это новая редакция и новое одобрение.',
    '- Входные артефакты приложены ниже целиком. Не пересказывай их по памяти и не ' +
      'догадывайся о содержимом — работай по тексту.',
    // Самопросмотр — шаг ВНУТРИ этапа 5, а не восьмой этап: `STAGE_ORDER` это контракт
    // методологии, и лишний этап означал бы расхождение с каноническим форматом `.sdlc/`,
    // который читают и скиллы `/sdlc-*`.
    ...(i.stage.id === 'chunk'
      ? [
          '- Прежде чем закончить этап, просмотри СВОЙ diff по углам ревью: построчно (что ' +
            'ломает каждую изменённую строку), удалённое поведение (какой инвариант держала ' +
            'каждая убранная строка и где он восстановлен), вызывающие изменённых функций, ' +
            'переиспользование (не написал ли ты то, что в кодобазе уже есть). Найденное ' +
            'чини в ЭТОЙ ЖЕ попытке и записывай в ' +
            `\`${toPosix(i.ctx.paths.selfReview(i.ctx.chunk, i.ctx.attempt))}\`.`,
          '- Этот самопросмотр НЕ заменяет независимого рецензента этапа 6 и в вердикт не ' +
            'входит: автор не рецензирует себя. Он нужен, чтобы не тратить дорогую попытку ' +
            'на то, что видно самому.',
        ]
      : []),
    // Остальные строки блока описывают то, что обеспечено конструкцией рантайма. Эта — про
    // то, что рантайм увидел в дереве, и сформулирована как проверяемый факт: «гейты
    // прогоняют вот эту команду», а не «пиши идиоматично».
    ...(i.ecosystem === undefined || i.ecosystem.length === 0
      ? []
      : [
          i.ecosystem.length === 1
            ? '- Как этот проект проверяется на этапе 6:'
            : `- Модулей в плане несколько (${i.ecosystem.length}), и гейты идут по каждому. ` +
              'Как они проверяются на этапе 6:',
          ...i.ecosystem.map(
            (m) =>
              `  - \`${m.dir}\` (${m.label}): ` +
              // «Сборки нет» — тоже факт, и умолчать о нём значит дать модели повод
              // выдумать команду сборки для языка, где её не бывает.
              (m.build === null
                ? 'шага сборки нет (язык без компиляции), проверяется синтаксис изменённых файлов, тесты '
                : `сборка \`${m.build}\`, тесты `) +
              (m.test === null
                ? '— НЕ ЗАПУСКАЮТСЯ: раннера тут нет, и пункты приёмки, проверяемые только ' +
                  'тестом, останутся неподтверждёнными.'
                : `\`${m.test}\`.`),
          ),
        ]),
  ];

  return lines.join('\n');
}

/**
 * Пример «мысль → вызов инструмента» для слабой модели — из РЕАЛЬНОГО бланка этапа.
 *
 * Пример не зашивается текстом: копия строки методологии в коде разошлась бы с шаблоном
 * при первой его правке (первая версия и разошлась — учила `- **Зачем:** ‹…›`, которого
 * в шаблоне интента нет). Берётся первый настоящий плейсхолдер первого разложенного
 * артефакта ЭТОГО этапа: такой `old_string` гарантированно найдётся, а путь гарантированно
 * разрешён к записи. Бланков с плейсхолдерами нет — примера нет, блок молчит.
 */
function fewShotLines(i: BuildPromptInput): string[] {
  for (const path of i.stage.produces(i.ctx)) {
    const a = readArtifact(path);
    if (!a.exists) continue;
    const r = placeholderRanges(a.text)[0];
    if (r === undefined) continue;

    const lineStart = a.text.lastIndexOf('\n', r.start - 1) + 1;
    const lineEnd = a.text.indexOf('\n', r.start);
    const line = a.text.slice(lineStart, lineEnd < 0 ? a.text.length : lineEnd).trim();
    if (line === '' || line.length > 200) continue;

    const rel = toPosix(relative(i.ctx.paths.projectRoot, path));
    const filledLine = line.replace(r.text, '(твоё содержимое по факту задачи)');
    const callJson = JSON.stringify({
      tool: 'Edit',
      arguments: { file_path: rel, old_string: line, new_string: filledLine },
    });
    return [
      '- Как выглядит сделанный шаг. Вот настоящая незаполненная строка твоего бланка — ' +
        'правильное действие это ОДИН вызов инструмента с готовым содержимым:',
      '  ```json',
      `  ${callJson}`,
      '  ```',
      '  Когда в артефакте не осталось `‹…›` — вызови `FinalizeArtifact` с путём артефакта.',
      '- НЕПРАВИЛЬНО: печатать содержимое файла текстом в ответе (текст никуда не ' +
        'записывается), спрашивать человека о том, что видно из кода, продолжать читать ' +
        'файлы, когда контекста для правки уже достаточно.',
    ];
  }
  return [];
}

function fence(path: string, text: string, maxBytes: number): string {
  const r = capBytes(text, maxBytes);
  const body = r.capped
    ? `${r.text}\n…[обрезано рантаймом: файл длиннее ${maxBytes} байт]`
    : r.text;
  return ['````markdown', `<!-- ${path} -->`, body, '````'].join('\n');
}

function userMessage(i: BuildPromptInput): string {
  const parts: string[] = [];

  if (i.requirement !== undefined && i.requirement.trim() !== '') {
    parts.push('## Задача от человека', '', i.requirement.trim());
  }

  const inputs = stageInputs(i.stage.id, i.ctx);
  const present: string[] = [];
  const missing: string[] = [];

  const maxBytes =
    i.flow === 'loop' && LOOP_CAPPED_STAGES.has(i.stage.id)
      ? LOOP_MAX_ARTIFACT_BYTES
      : MAX_ARTIFACT_BYTES;
  for (const input of inputs) {
    const a = readArtifact(input.path);
    const rel = toPosix(relative(i.ctx.paths.projectRoot, input.path));
    if (a.exists) present.push(fence(rel, a.text, maxBytes));
    else if (!input.optional) missing.push(rel);
  }

  if (present.length > 0) {
    parts.push('## Входные артефакты', '', present.join('\n\n'));
  }

  if (missing.length > 0) {
    // Обязательный вход отсутствует — это ловится предусловиями до сборки промпта,
    // но если сюда всё же дошло, модель должна знать, а не додумывать.
    parts.push(
      '## Отсутствующие входы',
      '',
      `Эти обязательные артефакты не найдены: ${missing.join(', ')}. Не додумывай их содержимое.`,
    );
  }

  // Карточка фактов от человека — только на этапе 5 и ПОСЛЕ входных артефактов: у слабой
  // модели решает recency, и ответ, утонувший в середине clarification-report.md, здесь
  // повторён коротко у самого конца промпта. Замер (серии r7–r8, `docs/model-runs.md`):
  // human-кейсы — единственный порог, где 8B проигрывает 14B по существу.
  if (i.stage.id === 'chunk') {
    const clar = readArtifact(i.ctx.paths.clarificationReport);
    const facts = clar.exists ? extractHumanFacts(clar.text) : [];
    if (facts.length > 0) {
      parts.push(
        '## Факты от человека — обязаны попасть в код',
        '',
        'Это ответы человека из clarification-report.md, дословно. Каждое число и каждая ' +
          'цитата из ответа обязаны быть отражены в правке; потерянный ответ человека — ' +
          'прямой путь к красному вердикту этапа 6.',
        facts
          .map(
            (f) =>
              `- **${f.question}** → ${f.answer}` +
              (f.literals.length === 0
                ? ''
                : ` _(проверяемые литералы: ${f.literals.map((l) => l.shown).join(', ')})_`),
          )
          .join('\n'),
      );
    }
  }

  if (i.extra !== undefined && i.extra.trim() !== '') {
    parts.push('## Что чинить в этой попытке', '', i.extra.trim());
  }

  return parts.join('\n\n');
}

export function buildPrompt(i: BuildPromptInput): PreparedPrompt {
  const skillBody = readSkillBody(i.runner.skillsDir, i.stage.skill);
  const system = `${skillBody}\n\n---\n\n${adapterBlock(i)}`;

  const specs = specsFor(i.tools ?? i.stage.tools);
  const tools = [
    ...specs.map((s) => ({
      name: i.flow === 'sdk' ? s.sdkName : s.name,
      description: s.description,
      schema: s.schema,
    })),
    // Внешние MCP-инструменты показываются оператору в том же списке и под теми же
    // именами, под какими уйдут в модель: панель промпта не должна врать про набор.
    ...(i.mcpTools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.schema,
    })),
  ];

  return {
    presetNote:
      i.flow === 'sdk'
        ? 'Флоу sdk: сверх этого текста Claude Code добавляет собственный системный пресет ' +
          '(описание встроенных инструментов и правил харнесса). Он не редактируется и здесь ' +
          'не показан — всё остальное, что уйдёт в модель, видно ниже.'
        : null,
    system,
    user: userMessage(i),
    tools,
    editedByOperator: false,
  };
}
