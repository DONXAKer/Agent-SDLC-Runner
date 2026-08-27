import type { FlowId, StageId } from '@sdlc-runner/shared';

export interface RunnerLimits {
  maxToolResultBytes: number;
  readRangeRequiredAboveBytes: number;
  maxIterationsPerStage: number;
  /**
   * Потолок на один гейт. Сборка и тест-сьют — самые долгие шаги витка, и повесить на
   * них этап навсегда проще всего: `⏭` по таймауту роняет вердикт честно, зависший
   * процесс не роняет ничего.
   */
  gateTimeoutMs: number;
  /**
   * Потолок на один запрос к модели во флоу `loop`. Локальный сервер, ушедший в своп,
   * соединение не закрывает — без своего таймаута этап висел бы до отмены оператором.
   */
  chatTimeoutMs: number;
  /**
   * Порог близости патчей, выше которого попытка называется топтанием на месте.
   *
   * Настройка, а не константа: число подобрано умозрительно, сквозной виток на живом
   * репозитории ни разу не прогонялся, и вокруг него нельзя строить логику. Эскалацию
   * порог не включает — он только называет факт оператору.
   */
  progressClosenessWarn: number;
}

export interface RunnerConfig {
  port: number;
  operator: string;
  /** Тексты этапов читаются отсюда в рантайме — эталон остаётся источником правды. */
  skillsDir: string;
  agentsDir: string;
  methodologyDir: string;
  limits: RunnerLimits;
}

export type ProviderKind = 'claude-agent-sdk' | 'anthropic-api' | 'openai-compat';

export interface ProviderDef {
  flow: FlowId;
  kind: ProviderKind;
  baseUrl?: string;
  /** Умеет ли выгружать/подгружать модель под запрос. vLLM — нет, Ollama — да. */
  swapsModels?: boolean;
}

export interface ModelDef {
  id: string;
  provider: string;
  model: string;
  /**
   * Проставляется руками. Нужен ровно для одного: правила методологии «рецензент этапа 6
   * строго сильнее исполнителя этапа 5».
   */
  rank: number;
}

export interface ModelsConfig {
  providers: Record<string, ProviderDef>;
  models: ModelDef[];
}

export interface ProfileDef {
  label: string;
  /**
   * Модель этапа. Список — ансамбль: несколько независимых прогонов одного этапа.
   * Строка означает список из одного, поэтому существующие конфиги не меняются.
   */
  stages: Record<StageId, string | string[]>;
}

/**
 * Явное описание модуля целевого проекта: чем он собирается и чем тестируется.
 *
 * Нужно там, где автодетект бессилен или неправ: моно-репо с двумя языками, нестандартная
 * команда сборки, модуль без привычного манифеста. Детект остаётся запасным вариантом —
 * пустой список означает сегодняшнее поведение, и ни один существующий конфиг не ломается.
 */
export interface ModuleProfile {
  /** Путь модуля относительно `projectRoot`. `.` — корень проекта. */
  dir: string;
  /** Идентификатор экосистемы из реестра. Необязателен, если задана команда сборки. */
  ecosystem?: string;
  /** Команда сборки. Перекрывает и экосистему, и детект. */
  build?: string;
  /**
   * Команда тестов. `null` — раннера нет НАМЕРЕННО: это утверждение проекта о себе, и
   * подменять его детектом нельзя.
   */
  test?: string | null;
  /** Команда линтера — для гейта идиоматичности, когда он появится в наборе. */
  lint?: string;
}

/**
 * Переопределение одного MCP-сервера поверх описания из `.mcp.json` целевого проекта.
 *
 * Все поля необязательные: указывают только то, что отличается. Копировать сюда команду
 * и пути целиком значило бы завести второе знание об одном, и оно разъехалось бы с
 * проектом на первой же его правке.
 */
export interface McpServerOverride {
  enabled?: boolean;
  type?: 'stdio' | 'http';
  command?: string;
  /** Заменяет список целиком: поэлементное слияние аргументов командной строки неотлаживаемо. */
  args?: string[];
  /** Сливается по ключам — чтобы добавить одну переменную, не переписывая блок. */
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /**
   * Опросные инструменты (шаблоны с `*`): их повтор не считается топтанием на месте.
   * `pie_status` и `wait_for_condition` для того и существуют, чтобы звать их подряд.
   */
  pollingTools?: string[];
}

/** Разрешение на инструмент в конфиге витка: `mode` и аргументы-пути задаёт человек. */
export interface McpToolAllow {
  /** Точное имя инструмента или префикс с одной завершающей `*`. */
  tool: string;
  /** Умолчание — `write`: неназванный класс считается изменяющим. */
  mode?: 'read' | 'write';
  pathArgs?: { key: string; access?: 'read' | 'write' }[];
}

export interface McpProjectConfig {
  enabled?: boolean;
  /** Путь к файлу серверов относительно корня проекта. Умолчание — `.mcp.json`. */
  fromProjectFile?: string;
  /**
   * Что делать с сервером, который есть в `.mcp.json` и не упомянут в `servers`.
   *
   * Умолчание намеренно запретительное: `.mcp.json` пишется для Claude Code, где каждое
   * подключение подтверждает человек диалогом. Раннер работает полуавтономно, и новый
   * сервер в чужом файле не должен молча расширять его досягаемость.
   */
  unlistedServers?: 'off' | 'on';
  servers?: Record<string, McpServerOverride>;
  /** Разрешённые инструменты по этапам: `"chunk": { "unreal-mcp": [ … ] }`. */
  stages?: Record<string, Record<string, (string | McpToolAllow)[]>>;
  /** Потолок числа MCP-инструментов, отдаваемых модели на этап. */
  maxInlineTools?: number;
  /** Свой потолок на результат MCP-вызова, обычно жёстче общего `maxToolResultBytes`. */
  maxResultBytes?: number;
}

export interface ProjectConfig {
  name: string;
  projectRoot: string;
  activeProfile: string;
  maxBudgetUsd: number;
  profiles: Record<string, ProfileDef>;
  /** Внешние MCP-серверы. Не задано — раннер про MCP этого проекта не знает. */
  mcp?: McpProjectConfig;
  /**
   * Модули проекта, описанные человеком. Пусто или не задано — работает автодетект.
   * Приоритет источников: команда из `.sdlc/gates.md` > это описание > детект.
   */
  modules?: ModuleProfile[];
}

export interface ResolvedRoute {
  stage: StageId;
  modelId: string;
  provider: string;
  providerDef: ProviderDef;
  model: string;
  flow: FlowId;
  rank: number;
}

export interface ResolvedProfile {
  name: string;
  label: string;
  /**
   * Основной маршрут этапа — первый из списка. От него зависят выбор исполнителя и
   * событие `stage_started`, поэтому поле оставлено одиночным: переписывать всех
   * потребителей ради ансамбля не нужно.
   */
  routes: Record<StageId, ResolvedRoute>;
  /** Все маршруты этапа. Для не-ансамблевых этапов — список из одного элемента. */
  ensemble: Record<StageId, ResolvedRoute[]>;
}
