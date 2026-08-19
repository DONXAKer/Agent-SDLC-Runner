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
  stages: Record<StageId, string>;
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

export interface ProjectConfig {
  name: string;
  projectRoot: string;
  activeProfile: string;
  maxBudgetUsd: number;
  profiles: Record<string, ProfileDef>;
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
  routes: Record<StageId, ResolvedRoute>;
}
