/**
 * Контракт HTTP-ответов.
 *
 * Живёт в общем пакете, а не у каждой стороны своей копией: до этого сервер и интерфейс
 * держали по своему описанию `RunDetail`, и они успели разойтись — интерфейс продолжал
 * ждать поле `events`, которое сервер перестал отдавать. Типы здесь — единственное
 * описание, и расхождение теперь ловится сборкой, а не глазами.
 */

import type {
  FlowId,
  GateRunResult,
  NormalizedCall,
  PolicyVerdict,
  PreparedPrompt,
  Question,
  StageId,
  Usage,
  Verdict,
} from './types.ts';

export interface RouteInfo {
  stage: StageId;
  modelId: string;
  provider: string;
  model: string;
  flow: FlowId;
  rank: number;
}

export interface StageInfo {
  id: StageId;
  title: string;
  tools: readonly string[];
  /** Причины, по которым этап не начинается. Пусто — можно стартовать. */
  blockers: string[];
  /**
   * То же для объявленного обрыва витка. `null` — у этого этапа обрыва нет.
   *
   * Отдельным полем, потому что у handoff'а два законных входа с разными предусловиями:
   * штатная приёмка требует отчёта и вердикта, а обрыв — единственный способ оставить
   * запись о том, почему виток бросили. Пока считался только штатный вход, интерфейс
   * показывал обрыв заблокированным ровно в том случае, ради которого он и существует.
   */
  abortBlockers: string[] | null;
  produces: string[];
  /**
   * Поле решения человека, которое этот этап оставляет после себя. `null` — решения
   * здесь нет. Интерфейс по нему рисует кнопку приёмки: решение существует только
   * записанным в артефакт, поэтому кнопка обязана быть там же, где этап.
   */
  decision: { artifact: string; label: string } | null;
}

export interface RunSummary {
  runId: string;
  slug: string;
  project: string;
  profile: string;
  status: string;
  stage: StageId | null;
  chunk: number;
  attempt: number;
  usage: Usage;
}

export interface PendingApproval {
  runId: string;
  stage: StageId;
  requestId: string;
  /** Имя инструмента, как его назвал исполнитель. */
  toolName: string;
  /**
   * Аргументы инструмента до нормализации — то, что правит оператор.
   *
   * Правится именно этот объект, а не `call`: исполнителю уходит `updatedInput` в форме
   * инструмента (`file_path`, `old_string`, …), и подсунуть ему нормализованную форму
   * (`path`, `oldStr`) значило отдать вызов с потерянными полями.
   */
  rawInput: Record<string, unknown>;
  call: NormalizedCall;
  policy: PolicyVerdict;
  preview: { path: string; before: string | null; after: string } | null;
  writeTargets: string[] | null;
}

export interface PendingQuestions {
  runId: string;
  stage: StageId;
  requestId: string;
  questions: Question[];
}

export interface RunDetail extends RunSummary {
  projectRoot: string;
  routes: Record<StageId, RouteInfo>;
  attemptBudget: number;
  maxBudgetUsd: number;
  stages: StageInfo[];
  pendingApprovals: PendingApproval[];
  pendingQuestions: PendingQuestions[];
  /** Итоги последнего прогона гейтов. Пусто — этап 6 ещё не запускался. */
  gateResults: GateRunResult[];
  /** Вердикт последней попытки. `null` — не считался. */
  verdict: Verdict | null;
  // Историю событий здесь не отдаём: клиент получает её по WebSocket при подключении,
  // а дублирование гоняло по проводу полные тексты файлов впустую.
}

export interface ProjectInfo {
  name: string;
  projectRoot: string;
  activeProfile: string;
  maxBudgetUsd: number;
  profiles: { name: string; label: string; stages: Record<StageId, string> }[];
}

export interface ConfigInfo {
  operator: string;
  projects: ProjectInfo[];
  models: { id: string; provider: string; model: string; rank: number }[];
  stages: { id: StageId; title: string; tools: readonly string[] }[];
  /** Обзор каталогов доступен, только если на сервере задан `SDLC_BROWSE_ROOT`. */
  browseEnabled: boolean;
}

export interface BrowseEntry {
  name: string;
  path: string;
}

export interface BrowseResult {
  root: string;
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export interface PromptResponse {
  prompt: PreparedPrompt;
  blockers: string[];
}
