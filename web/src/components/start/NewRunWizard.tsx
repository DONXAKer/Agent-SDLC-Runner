import { useState } from 'react';

import type { ConfigInfo, ProjectInfo, StageId } from '@sdlc-runner/shared';

import { evaluateReviewerRule } from '../../lib/reviewerRule.ts';
import {
  WIZARD_STEPS,
  WIZARD_TITLES,
  canProceed,
  nextStep,
  prevStep,
  stepBlocker,
} from '../../lib/startWizard.ts';
import type { WizardStep } from '../../lib/startWizard.ts';
import { DirectoryBrowser } from '../DirectoryBrowser.tsx';
import { ProfileEditor } from '../ProfileEditor.tsx';

/**
 * Мастер нового витка: проект → профиль и модели → задача и запуск.
 *
 * До него всё это лежало одной колонкой, развёрнутой всегда: карточки профилей с
 * помоделной разбивкой по семи этапам, правка моделей и обзор каталогов занимали
 * бо́льшую часть экрана, хотя при одном проекте и одном профиле единственный
 * обязательный ввод — slug. Здесь дефолты выбраны заранее, и путь по умолчанию — два
 * «Далее» и текст задачи.
 *
 * Правило рецензента считается на каждом шаге и запирает переход (`stepBlocker`), а не
 * только краснеет текстом: раньше клиент предупреждал и пропускал дальше, а отказывал уже
 * сервер — после создания витка.
 */
export function NewRunWizard({
  config,
  project,
  profile,
  stageOverrides,
  requirement,
  slug,
  onProjectChange,
  onProfileChange,
  onStageOverridesChange,
  onRequirementChange,
  onSlugChange,
  onAddProject,
  onStart,
  onCancel,
}: {
  config: ConfigInfo;
  project: ProjectInfo | null;
  profile: string;
  stageOverrides: Partial<Record<StageId, string>>;
  requirement: string;
  slug: string;
  onProjectChange: (p: ProjectInfo | null) => void;
  onProfileChange: (name: string) => void;
  onStageOverridesChange: (next: Partial<Record<StageId, string>>) => void;
  onRequirementChange: (v: string) => void;
  onSlugChange: (v: string) => void;
  /** Завести проект по выбранному каталогу; возвращает заведённый, чтобы мастер его выбрал. */
  onAddProject: (name: string, path: string) => Promise<ProjectInfo | null>;
  onStart: () => void;
  /** Уйти из мастера к спискам витков. `null` — уходить некуда (продолжать нечего). */
  onCancel: (() => void) | null;
}): JSX.Element {
  const [step, setStep] = useState<WizardStep>(1);
  const [browsing, setBrowsing] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  const base =
    project?.profiles.find((p) => p.name === profile)?.stages ?? ({} as Record<StageId, string[]>);
  const rule = evaluateReviewerRule({ models: config.models, stages: stageOverrides, base });

  const state = { projectChosen: project !== null, ruleBroken: rule.broken, slug };
  const blocker = stepBlocker(step, state);
  const ready = canProceed(step, state);

  const addProject = async (): Promise<void> => {
    if (pendingPath === null || newName.trim() === '') return;
    const p = await onAddProject(newName.trim(), pendingPath);
    if (p === null) return;
    setPendingPath(null);
    setNewName('');
  };

  return (
    <div className="rounded border border-neutral-800 p-4">
      <div className="mb-4 flex items-center gap-3">
        <span className="text-sm font-medium">Новый виток</span>
        <span className="ml-auto text-xs text-neutral-500">Шаг {step} из 3</span>
      </div>

      {/* Полоса шагов: пройденные — галочкой, как в рельсе этапов витка. */}
      <div className="mb-4 flex items-center gap-1">
        {WIZARD_STEPS.map((s, i) => (
          <div key={s} className="flex flex-1 items-center gap-1">
            <span
              className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
                s < step
                  ? 'bg-emerald-900/70 text-emerald-300'
                  : s === step
                    ? 'bg-emerald-800 text-emerald-100 ring-2 ring-emerald-500/50'
                    : 'bg-neutral-800 text-neutral-500'
              }`}
            >
              {s < step ? '✓' : s}
            </span>
            <span
              className={`truncate text-xs ${s === step ? 'text-neutral-200' : 'text-neutral-500'}`}
            >
              {WIZARD_TITLES[s]}
            </span>
            {i < WIZARD_STEPS.length - 1 ? (
              <span className="h-px flex-1 bg-neutral-800" />
            ) : null}
          </div>
        ))}
      </div>

      {step === 1 ? (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            {config.projects.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => {
                  onProjectChange(p);
                  onProfileChange(p.activeProfile);
                  // Панель добавления относится к обзору каталогов, а не к выбору из
                  // списка — оставленная висеть под уже другим проектом сбивает с толку.
                  setPendingPath(null);
                  setNewName('');
                }}
                className={`rounded border p-3 text-left text-sm transition ${
                  project?.name === p.name
                    ? 'border-emerald-600 bg-emerald-950/30'
                    : 'border-neutral-800 hover:border-neutral-600'
                }`}
              >
                <div className="truncate font-medium">{p.name}</div>
                <div className="truncate font-mono text-[11px] text-neutral-500">
                  {p.projectRoot}
                </div>
              </button>
            ))}
          </div>

          {config.browseEnabled ? (
            <button
              type="button"
              onClick={() => setBrowsing(true)}
              className="text-xs text-emerald-500 hover:text-emerald-400"
            >
              + добавить обзором каталогов
            </button>
          ) : null}

          {browsing ? (
            <DirectoryBrowser
              onClose={() => setBrowsing(false)}
              onPick={(path) => {
                setBrowsing(false);
                setPendingPath(path);
              }}
            />
          ) : null}

          {pendingPath !== null ? (
            <div className="rounded border border-neutral-800 p-3">
              <div className="mb-2 truncate font-mono text-xs text-neutral-400">{pendingPath}</div>
              <label className="block">
                <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
                  Имя проекта
                </span>
                <div className="flex gap-2">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="my-project"
                    className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-2 font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => void addProject()}
                    disabled={newName.trim() === ''}
                    className="shrink-0 rounded bg-emerald-700 px-3 py-2 text-sm font-medium hover:bg-emerald-600 disabled:bg-neutral-800 disabled:text-neutral-500"
                  >
                    Добавить
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingPath(null)}
                    className="shrink-0 rounded border border-neutral-800 px-3 py-2 text-sm hover:border-neutral-600"
                  >
                    Отмена
                  </button>
                </div>
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      {step === 2 ? (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {(project?.profiles ?? []).map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => onProfileChange(p.name)}
                className={`rounded border p-3 text-left text-sm transition ${
                  profile === p.name
                    ? 'border-emerald-600 bg-emerald-950/30'
                    : 'border-neutral-800 hover:border-neutral-600'
                }`}
              >
                <div className="font-medium">{p.label}</div>
                <div className="mt-1 space-y-0.5 font-mono text-[11px] text-neutral-500">
                  {/* `m` — список маршрутов (ансамбль). Как есть его рендерить нельзя:
                      React склеивает элементы массива без разделителя, и две модели
                      выглядели одной выдуманной — `claude-sdk:opusclaude-sdk:sonnet`. */}
                  {Object.entries(p.stages).map(([s, m]) => (
                    <div key={s}>
                      {s.padEnd(8, ' ')} {m.join(' + ')}
                    </div>
                  ))}
                </div>
              </button>
            ))}
          </div>

          {config.models.length > 0 ? (
            <ProfileEditor
              models={config.models}
              base={base}
              stages={stageOverrides}
              onChange={onStageOverridesChange}
            />
          ) : null}

          <p className="text-xs text-neutral-500">
            Виток не стартует, если модель на <code className="font-mono">verify</code> не
            строго сильнее модели на <code className="font-mono">chunk</code>: ревью слабее
            исполнителя — декорация, а «Ревью независимым агентом» входит в минимальную
            пятёрку гейтов и выключателя не имеет.
          </p>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="space-y-3">
          <div className="rounded border border-neutral-800 px-3 py-2 text-xs text-neutral-400">
            {project?.name ?? '—'} · профиль {profile === '' ? '—' : profile}
            <span className="ml-2 font-mono text-neutral-600">{project?.projectRoot ?? ''}</span>
          </div>

          {/* Задача набирается здесь, а не внутри витка: «Начать виток» без неё был
              переходом на второй экран, где оператор заново соображал, что делать.
              Текст уходит на этап intent и остаётся там редактируемым. */}
          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
              Задача витка — что нужно сделать
            </span>
            <textarea
              value={requirement}
              onChange={(e) => onRequirementChange(e.target.value)}
              placeholder="Например: платёж в статусе pending не переходит в failed по таймауту провайдера"
              className="h-28 w-full rounded border border-neutral-800 bg-neutral-950 p-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
              Slug витка — имя каталога артефактов
            </span>
            <input
              value={slug}
              onChange={(e) => onSlugChange(e.target.value)}
              placeholder="pay-412"
              className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-2 font-mono text-sm"
            />
          </label>
        </div>
      ) : null}

      {/* Причина, по которой «Далее» заперта, названа словами: молча заблокированная
          кнопка читается как поломка — тот же урок, что у блокеров этапа. */}
      {blocker !== null ? <p className="mt-3 text-xs text-red-300">{blocker}</p> : null}

      <div className="mt-4 flex items-center gap-2">
        {step > 1 ? (
          <button
            type="button"
            onClick={() => setStep(prevStep(step))}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800"
          >
            ← Назад
          </button>
        ) : onCancel !== null ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-neutral-800 px-3 py-1.5 text-sm text-neutral-400 hover:border-neutral-600"
          >
            Отмена
          </button>
        ) : null}

        {step < 3 ? (
          <button
            type="button"
            onClick={() => setStep(nextStep(step))}
            disabled={!ready}
            className="ml-auto rounded bg-emerald-700 px-4 py-1.5 text-sm font-medium hover:bg-emerald-600 disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            Далее →
          </button>
        ) : (
          <button
            type="button"
            onClick={onStart}
            disabled={!ready}
            className="ml-auto rounded bg-emerald-700 px-4 py-1.5 text-sm font-medium hover:bg-emerald-600 disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            Начать виток
          </button>
        )}
      </div>
    </div>
  );
}
