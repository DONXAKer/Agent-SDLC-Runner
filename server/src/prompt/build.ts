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

import { readArtifact } from '../artifacts/artifact.ts';
import type { RunnerConfig } from '../config/schema.ts';
import { specsFor } from '../exec/toolSpecs.ts';
import { toPosix } from '../policy/paths.ts';
import type { StageContext, StageDef } from '../run/stages.ts';
import { stageInputs } from '../run/stages.ts';
import type { FlowId, PreparedPrompt } from '@sdlc-runner/shared';

const MAX_ARTIFACT_BYTES = 40_000;

export interface BuildPromptInput {
  runner: RunnerConfig;
  stage: StageDef;
  ctx: StageContext;
  flow: FlowId;
  slug: string;
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
    `- Формы артефактов лежат в \`${templates}\` — читай их оттуда через Read, не сочиняй структуру.`,
    `- Вместо \`AskUserQuestion\` вызывай \`${askTool}\`: этап встаёт на паузу, пока человек не ` +
      'ответит в интерфейсе. Правила те же — до 4 вопросов за вызов, блокирующие первыми, ' +
      'один вопрос это одна неопределённость, у каждого варианта в описании названа цена ошибки.',
    `- Вместо \`ExitPlanMode\` бери одобрение тем же \`${askTool}\`.`,
    '- Решение человека записывай полем в артефакт: молчание одобрением не считается, ' +
      'а одобрение, оставшееся в переписке, для следующего этапа не существует.',
    `- Оператор: **${i.runner.operator}**. Сегодня: **${date}**. Эти значения подставляй в поля решений.`,
    `- Текущий chunk: **${i.ctx.chunk}**, попытка: **${i.ctx.attempt}**.`,
    `- Доступные инструменты на этом этапе: ${i.stage.tools.join(', ')}. Других у тебя нет — ` +
      'права выдаются на шаг, а не на прогон.',
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

function fence(path: string, text: string): string {
  const capped =
    text.length > MAX_ARTIFACT_BYTES
      ? `${text.slice(0, MAX_ARTIFACT_BYTES)}\n…[обрезано рантаймом: файл длиннее ${MAX_ARTIFACT_BYTES} символов]`
      : text;
  return ['````markdown', `<!-- ${path} -->`, capped, '````'].join('\n');
}

function userMessage(i: BuildPromptInput): string {
  const parts: string[] = [];

  if (i.requirement !== undefined && i.requirement.trim() !== '') {
    parts.push('## Задача от человека', '', i.requirement.trim());
  }

  const inputs = stageInputs(i.stage.id, i.ctx);
  const present: string[] = [];
  const missing: string[] = [];

  for (const input of inputs) {
    const a = readArtifact(input.path);
    const rel = toPosix(relative(i.ctx.paths.projectRoot, input.path));
    if (a.exists) present.push(fence(rel, a.text));
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

  if (i.extra !== undefined && i.extra.trim() !== '') {
    parts.push('## Что чинить в этой попытке', '', i.extra.trim());
  }

  return parts.join('\n\n');
}

export function buildPrompt(i: BuildPromptInput): PreparedPrompt {
  const skillBody = readSkillBody(i.runner.skillsDir, i.stage.skill);
  const system = `${skillBody}\n\n---\n\n${adapterBlock(i)}`;

  const specs = specsFor(i.stage.tools);
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
