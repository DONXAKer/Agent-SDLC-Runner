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

export interface ProjectConfig {
  name: string;
  projectRoot: string;
  activeProfile: string;
  maxBudgetUsd: number;
  profiles: Record<string, ProfileDef>;
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
