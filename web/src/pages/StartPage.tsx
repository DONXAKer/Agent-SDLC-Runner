import { useState } from 'react';

import type { ConfigInfo, HistoryEntry, ProjectInfo, RunSummary, StageId } from '@sdlc-runner/shared';

import { HistoryList } from '../components/HistoryList.tsx';
import { RunList } from '../components/RunList.tsx';
import { NewRunWizard } from '../components/start/NewRunWizard.tsx';
import { wizardOpenByDefault } from '../lib/startWizard.ts';
import { PANEL_TONE } from '../lib/tones.ts';

/**
 * Стартовый экран: продолжить начатое или завести новый виток.
 *
 * Раньше и то и другое лежало одной колонкой из тринадцати блоков, разделённой лишь
 * строчкой «НОВЫЙ ВИТОК» — списки витков и полностью развёрнутая форма создания были
 * визуально равноправны, хотя это два разных намерения. Теперь продолжение видно сразу,
 * а создание живёт в мастере (`NewRunWizard`), который открывается по кнопке — либо сам,
 * когда продолжать нечего.
 */
export function StartPage({
  config,
  error,
  runs,
  history,
  project,
  profile,
  slug,
  requirement,
  stageOverrides,
  onProjectChange,
  onProfileChange,
  onSlugChange,
  onRequirementChange,
  onStageOverridesChange,
  onOpenRun,
  onOpenHistory,
  onForget,
  onRefreshRuns,
  onRefreshHistory,
  onAddProject,
  onStart,
}: {
  config: ConfigInfo;
  error: string | null;
  runs: RunSummary[] | null;
  history: HistoryEntry[] | null;
  project: ProjectInfo | null;
  profile: string;
  slug: string;
  requirement: string;
  stageOverrides: Partial<Record<StageId, string>>;
  onProjectChange: (p: ProjectInfo | null) => void;
  onProfileChange: (name: string) => void;
  onSlugChange: (v: string) => void;
  onRequirementChange: (v: string) => void;
  onStageOverridesChange: (next: Partial<Record<StageId, string>>) => void;
  onOpenRun: (runId: string) => void;
  onOpenHistory: (slug: string) => void;
  onForget: (runId: string) => void;
  onRefreshRuns: () => void;
  onRefreshHistory: () => void;
  onAddProject: (name: string, path: string) => Promise<ProjectInfo | null>;
  onStart: () => void;
}): JSX.Element {
  const runsCount = runs?.length ?? 0;
  const historyCount = history?.length ?? 0;
  const hasSomethingToContinue = runsCount > 0 || historyCount > 0;
  // Начальное значение, а не постоянное: раскрытие мастера — выбор человека, и
  // подъехавший фоновым запросом список не вправе его закрыть.
  const [wizard, setWizard] = useState(() => wizardOpenByDefault(runsCount, historyCount));

  const stageTitles = Object.fromEntries(config.stages.map((s) => [s.id, s.title]));

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="mb-1 text-xl font-medium">Agent-SDLC Runner</h1>
      <p className="mb-6 text-sm text-neutral-400">
        Один виток: цель → разведка → вопросы → план → chunk → верификация → передача.
        Артефакты пишутся в <code className="font-mono">.sdlc/&lt;slug&gt;/</code> целевого проекта.
      </p>

      {error !== null ? (
        <div className={`mb-4 whitespace-pre-wrap rounded border p-3 text-sm text-red-200 ${PANEL_TONE.fail}`}>
          {error}
        </div>
      ) : null}

      <div className="space-y-4">
        {/* Условие видимости списков живёт здесь одно: пока оно было и внутри `RunList`,
            и снаружи у разделителя, любое изменение правила рассинхронизировало бы их. */}
        {runsCount > 0 && runs !== null ? (
          <RunList
            runs={runs}
            onOpen={onOpenRun}
            onForget={onForget}
            onRefresh={onRefreshRuns}
          />
        ) : null}

        {historyCount > 0 && history !== null ? (
          <HistoryList
            entries={history}
            stageTitles={stageTitles}
            compact
            onOpen={onOpenHistory}
            onRefresh={onRefreshHistory}
          />
        ) : null}

        {wizard ? (
          <NewRunWizard
            config={config}
            project={project}
            profile={profile}
            stageOverrides={stageOverrides}
            requirement={requirement}
            slug={slug}
            onProjectChange={onProjectChange}
            onProfileChange={onProfileChange}
            onStageOverridesChange={onStageOverridesChange}
            onRequirementChange={onRequirementChange}
            onSlugChange={onSlugChange}
            onAddProject={onAddProject}
            onStart={onStart}
            // Уходить из мастера некуда, когда продолжать нечего: закрытый мастер оставил
            // бы пустой экран с одной кнопкой.
            onCancel={hasSomethingToContinue ? () => setWizard(false) : null}
          />
        ) : (
          <button
            type="button"
            onClick={() => setWizard(true)}
            className="w-full rounded border border-neutral-800 px-4 py-3 text-left text-sm hover:border-neutral-600"
          >
            <span className="font-medium">+ Новый виток</span>
            <span className="ml-2 text-xs text-neutral-500">
              проект, профиль, задача — три шага
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
