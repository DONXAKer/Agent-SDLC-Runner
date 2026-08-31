/**
 * Описания инструментов — один источник для обоих флоу.
 *
 * Флоу `loop` отправляет эти JSON-схемы в модель как есть. Флоу `sdk` пользуется
 * встроенными инструментами Claude Code, у которых имена те же, поэтому схемы там служат
 * только для показа оператору в панели промпта — чтобы «полный промпт» не врал о том,
 * какие инструменты у агента на руках.
 *
 * `AskHuman` и `FinalizeArtifact` наши в обоих флоу: в `sdk` они приезжают как MCP-сервер.
 */

import type { BuiltinToolName, ToolName } from '@sdlc-runner/shared';

export interface ToolSpec {
  name: BuiltinToolName;
  /** Имя, под которым инструмент известен исполнителю флоу `sdk`. */
  sdkName: string;
  description: string;
  schema: Record<string, unknown>;
}

function obj(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const str = (description: string): Record<string, unknown> => ({ type: 'string', description });

/**
 * Схемы есть только у инструментов, которые раннер описывает сам.
 *
 * `McpRead`/`McpWrite` — не инструменты, а права: за ними стоят имена и схемы, приходящие
 * из `tools/list` живого сервера. Записать их сюда нечем, поэтому таблица параметризована
 * `BuiltinToolName`, и полнота по встроенным по-прежнему проверяется компилятором.
 */
export const TOOL_SPECS: Record<BuiltinToolName, ToolSpec> = {
  Read: {
    name: 'Read',
    sdkName: 'Read',
    description:
      'Прочитать файл проекта. Для больших файлов укажи диапазон строк — целиком он не влезет.',
    schema: obj(
      {
        file_path: str('Путь к файлу относительно корня проекта или абсолютный внутри него'),
        offset: { type: 'integer', description: 'Строка, с которой начать (с 1)' },
        limit: { type: 'integer', description: 'Сколько строк прочитать' },
      },
      ['file_path'],
    ),
  },

  Glob: {
    name: 'Glob',
    sdkName: 'Glob',
    description: 'Найти файлы по glob-шаблону, например `src/**/*.ts`.',
    schema: obj(
      { pattern: str('Glob-шаблон'), path: str('Каталог поиска; по умолчанию корень проекта') },
      ['pattern'],
    ),
  },

  Grep: {
    name: 'Grep',
    sdkName: 'Grep',
    description: 'Поиск по содержимому файлов регулярным выражением.',
    schema: obj(
      {
        pattern: str('Регулярное выражение'),
        path: str('Файл или каталог поиска; по умолчанию корень проекта'),
        glob: str('Дополнительный фильтр по именам файлов'),
      },
      ['pattern'],
    ),
  },

  Write: {
    name: 'Write',
    sdkName: 'Write',
    description:
      'Записать файл целиком. Запись вне files_to_touch одобренного плана отклоняется ' +
      'рантаймом в момент вызова — это конструкция, а не сбой.',
    schema: obj({ file_path: str('Путь к файлу'), content: str('Полное содержимое') }, [
      'file_path',
      'content',
    ]),
  },

  Edit: {
    name: 'Edit',
    sdkName: 'Edit',
    description: 'Заменить фрагмент в существующем файле. old_string должен встречаться ровно раз.',
    schema: obj(
      {
        file_path: str('Путь к файлу'),
        old_string: str('Фрагмент, который заменяем'),
        new_string: str('Чем заменяем'),
        replace_all: { type: 'boolean', description: 'Заменить все вхождения' },
      },
      ['file_path', 'old_string', 'new_string'],
    ),
  },

  Bash: {
    name: 'Bash',
    sdkName: 'Bash',
    description:
      'Выполнить команду в корне проекта. Разрушительные команды и запись мимо плана ' +
      'отклоняются рантаймом.',
    schema: obj(
      {
        command: str('Команда'),
        description: str('Одной строкой: что делает команда'),
        timeout: { type: 'integer', description: 'Таймаут в миллисекундах' },
      },
      ['command'],
    ),
  },

  AskHuman: {
    name: 'AskHuman',
    sdkName: 'mcp__sdlc__ask_human',
    description:
      'Задать вопрос человеку и дождаться ответа. Заменяет AskUserQuestion: этап встаёт на ' +
      'паузу, пока человек не ответит в интерфейсе. Максимум 4 вопроса за вызов, блокирующие ' +
      'первыми, один вопрос — одна неопределённость. К каждому варианту — цена ошибки в описании.',
    schema: obj(
      {
        questions: {
          type: 'array',
          maxItems: 4,
          items: obj(
            {
              question: str('Полный текст вопроса'),
              header: str('Короткая метка, до 12 символов'),
              multiSelect: { type: 'boolean', description: 'Можно выбрать несколько' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: obj({ label: str('Вариант'), description: str('Что это значит и чем грозит ошибка') }, [
                  'label',
                  'description',
                ]),
              },
            },
            ['question', 'header', 'multiSelect', 'options'],
          ),
        },
      },
      ['questions'],
    ),
  },

  Task: {
    name: 'Task',
    sdkName: 'Task',
    description:
      'Запустить субагента. Методология требует независимого исполнителя там, где судящий ' +
      'не должен быть автором: `sdlc-claims` на разведке (слепой вывод приёмочного листа), ' +
      '`sdlc-locator` на разведке места правки (у него нет прав записи по построению) и ' +
      '`sdlc-reviewer` на верификации. Доступны только субагенты, объявленные текущим этапом. ' +
      'Вызовы инструментов внутри субагента проходят через тот же гейт одобрений.',
    schema: obj(
      {
        subagent_type: str('Имя субагента из объявленных на этапе: sdlc-claims, sdlc-locator или sdlc-reviewer'),
        description: str('Коротко: что поручаем'),
        prompt: str('Полное задание субагенту'),
      },
      ['subagent_type', 'prompt'],
    ),
  },

  FinalizeArtifact: {
    name: 'FinalizeArtifact',
    sdkName: 'mcp__sdlc__finalize_artifact',
    description:
      'Объявить артефакт этапа готовым. Рантайм проверит, что в нём не осталось ' +
      'незаполненных мест «‹…›», и покажет его человеку.',
    schema: obj(
      {
        artifact: str('Путь к артефакту относительно корня проекта'),
        note: str('Одной строкой: что получилось'),
      },
      ['artifact'],
    ),
  },

  RecordClaim: {
    name: 'RecordClaim',
    sdkName: 'mcp__sdlc__record_claim',
    description:
      'Записать вывод по одному пункту приёмки. Таблицу §1 отчёта из этих записей рисует ' +
      'рантайм — колонки и форма получаются правильными по построению, а не по аккуратности ' +
      'оформления. Один вызов на пункт; повторный вызов с тем же id заменяет прежнюю запись. ' +
      '«Чем подтверждён» обязано указывать на МЕСТО: файл и символ, имя теста, хунк диффа.',
    schema: obj(
      {
        id: str('Идентификатор пункта из приёмочного листа задачи, например claim-3'),
        status: {
          type: 'string',
          enum: ['✅', '❌', '⚠', 'manual'],
          description:
            'Подтверждён / опровергнут / не проверяем / проверяется вручную. `manual` ' +
            'действителен, только если пункт помечен [manual] в задаче человеком.',
        },
        evidence: str('Чем подтверждён: файл:символ, имя теста, хунк диффа'),
        what_to_fix: str('Что чинить, если пункт не зелёный'),
      },
      ['id', 'status', 'evidence'],
    ),
  },

  RecordFinding: {
    name: 'RecordFinding',
    sdkName: 'mcp__sdlc__record_finding',
    description:
      'Записать находку ревью в свою секцию отчёта: расхождение (review), выход за границы ' +
      'плана (scope), нарушенный инвариант (invariant), регрессия ранее работавшего ' +
      'поведения (regression). Находка без ссылки на место принимается, но помечается ' +
      '«без привязки» — потерять её нельзя, выдать за доказанную тоже.',
    schema: obj(
      {
        section: {
          type: 'string',
          enum: ['review', 'scope', 'invariant', 'regression'],
          description: 'Секция отчёта приёмки, к которой относится находка',
        },
        text: str('Находка одной-двумя фразами: что именно не так'),
        evidence: str('Где это видно: файл:строка, символ, хунк диффа'),
      },
      ['section', 'text'],
    ),
  },

  RequestScopeExtension: {
    name: 'RequestScopeExtension',
    sdkName: 'mcp__sdlc__request_scope_extension',
    description:
      'Попросить человека расширить files_to_touch плана на файл, понадобившийся по ходу ' +
      'chunk\'а и не бывший в плане. Замена молчаливому нарушению scope и полной остановке ' +
      'chunk\'а. Решает человек; одобрение дописывает путь в plan.md с пометкой «расширено на ' +
      'этапе N» и разрешает запись в него на этом же chunk\'е. Отказ означает: делай без этого ' +
      'файла или остановись и спроси иначе.',
    schema: obj(
      {
        path: str('Путь к файлу относительно корня проекта, который нужно добавить в scope'),
        reason: str('Почему он понадобился и не был назван в плане'),
      },
      ['path', 'reason'],
    ),
  },
};

/** Права на MCP схемы не имеют — они приходят от сервера отдельным списком. */
export function isBuiltinToolName(name: ToolName): name is BuiltinToolName {
  return name !== 'McpRead' && name !== 'McpWrite';
}

/**
 * Имена инструментов, приходящие СТРОКАМИ извне рантайма — из YAML-шапки субагента,
 * которую пишет человек. Незнакомое имя не превращается в право: оно просто не попадает
 * в пересечение.
 *
 * Живёт рядом с реестром, а не у вызывающих: рукописный список имён был бы вторым
 * знанием об одном, и забытое в нём имя молча отнимало бы у субагента объявленное право.
 * `hasOwn`, а не `in`: объектный словарь отвечает `true` на `toString`.
 */
export function isToolName(v: string): v is ToolName {
  // Права на MCP в `TOOL_SPECS` не лежат — у них нет статических схем. Без этих двух имён
  // право, объявленное человеком в шапке субагента, молча выпало бы из пересечения.
  if (v === 'McpRead' || v === 'McpWrite') return true;
  return Object.hasOwn(TOOL_SPECS, v);
}

export function specsFor(tools: readonly ToolName[]): ToolSpec[] {
  return tools.filter(isBuiltinToolName).map((t) => TOOL_SPECS[t]);
}
