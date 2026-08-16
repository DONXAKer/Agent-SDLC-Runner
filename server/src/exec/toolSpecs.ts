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

import type { ToolName } from '../types.ts';

export interface ToolSpec {
  name: ToolName;
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

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
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
};

export function specsFor(tools: readonly ToolName[]): ToolSpec[] {
  return tools.map((t) => TOOL_SPECS[t]);
}
