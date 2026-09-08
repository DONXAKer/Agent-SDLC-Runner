import { useState } from 'react';

import type { ConfigInfo, HistoryEntry, ProjectInfo, StageId } from '@sdlc-runner/shared';

import { api } from '../../lib/api.ts';
import { historyStatusLabel } from '../../lib/historyStatus.ts';
import { evaluateReviewerRule } from '../../lib/reviewerRule.ts';
import {
  WIZARD_STEPS,
  WIZARD_TITLES,
  canProceed,
  nextStep,
  prevStep,
  slugFromText,
  stepBlocker,
  uniqueSlug,
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
  history,
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
  /** История витков выбранного проекта: занятость slug'а и «похожие витки». `null` — ещё не загружена. */
  history: HistoryEntry[] | null;
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
  const [probe, setProbe] = useState<{ running: boolean; lines: { model: string; cases: { name: string; ok: boolean; env: boolean; detail: string }[] | null; error: string | null }[] }>({ running: false, lines: [] });

  const base =
    project?.profiles.find((p) => p.name === profile)?.stages ?? ({} as Record<StageId, string[]>);
  const rule = evaluateReviewerRule({ models: config.models, stages: stageOverrides, base });

  /**
   * Модели эффективного профиля (правка поверх базы) без повторов — их и прогоняет проба.
   * Значение профиля — список маршрутов (ансамбль): первый — основной, остальные —
   * дополнительные рецензенты, и пробовать их тоже надо.
   */
  const effectiveModels = [
    ...new Set(
      (Object.keys(base) as StageId[])
        .flatMap((s) => (stageOverrides[s] !== undefined ? [stageOverrides[s]!] : (base[s] ?? [])))
        .filter((m) => m !== ''),
    ),
  ];

  const runProbe = async (): Promise<void> => {
    setProbe({ running: true, lines: effectiveModels.map((m) => ({ model: m, cases: null, error: null })) });
    for (const m of effectiveModels) {
      try {
        const r = await api.probe(m);
        setProbe((prev) => ({
          ...prev,
          lines: prev.lines.map((l) =>
            l.model === m ? { model: m, cases: r.report.cases, error: null } : l,
          ),
        }));
      } catch (e) {
        setProbe((prev) => ({
          ...prev,
          lines: prev.lines.map((l) =>
            l.model === m ? { model: m, cases: null, error: (e as Error).message } : l,
          ),
        }));
      }
    }
    setProbe((prev) => ({ ...prev, running: false }));
  };

  const state = { projectChosen: project !== null, ruleBroken: rule.broken, slug };
  const blocker = stepBlocker(step, state);
  const ready = canProceed(step, state);

  // Занятость slug'а и «похожие витки» считаются по истории проекта с диска: до похода
  // на сервер видно, что виток с таким именем уже есть, и подставлять его вслепую не надо.
  const takenSlugs = new Set((history ?? []).map((e) => e.slug));
  const slugTaken = slug.trim() !== '' && takenSlugs.has(slug.trim());
  const generatedSlug = slugFromText(requirement);
  const similar = (history ?? []).slice(0, 5);
  // Сводка «что уйдёт в работу» — тот же эффективный профиль, что пробу шагом выше:
  // оверрайд, если стоит, иначе базовый список маршрутов профиля.
  const effectiveByStage = Object.fromEntries(
    config.stages.map((s) => [
      s.id,
      stageOverrides[s.id] !== undefined ? [stageOverrides[s.id]!] : (base[s.id] ?? []),
    ]),
  );

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
          {/* `grid-cols-1` до `sm` обязателен: без явной одной колонки карточки на узком
              экране уезжали за край контейнера. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
                className={`min-w-0 rounded border p-3 text-left text-sm transition ${
                  project?.name === p.name
                    ? 'border-emerald-600 bg-emerald-950/30'
                    : 'border-neutral-800 hover:border-neutral-600'
                }`}
              >
                <div className="truncate font-medium" title={p.name}>
                  {p.name}
                </div>
                {/* Полный путь остаётся в `title` — на дисках с глубокой вложенностью
                    усечение без него прятало бы, где вообще лежит проект. */}
                <div className="truncate font-mono text-[11px] text-neutral-500" title={p.projectRoot}>
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
                className={`min-w-0 rounded border p-3 text-left text-sm transition ${
                  profile === p.name
                    ? 'border-emerald-600 bg-emerald-950/30'
                    : 'border-neutral-800 hover:border-neutral-600'
                }`}
              >
                <div className="truncate font-medium">{p.label}</div>
                <div className="mt-1 space-y-0.5 font-mono text-[11px] text-neutral-500">
                  {/* `m` — список маршрутов (ансамбль). Как есть его рендерить нельзя:
                      React склеивает элементы массива без разделителя, и две модели
                      выглядели одной выдуманной — `claude-sdk:opusclaude-sdk:sonnet`.
                      Ансамбль длинной строкой (провайдер + суффикс у каждой) уходит за
                      край карточки — режем до ширины карточки, полный список в title. */}
                  {Object.entries(p.stages).map(([s, m]) => (
                    <div key={s} className="truncate" title={`${s}: ${m.join(' + ')}`}>
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

          {/* Проба — скрининг перед дорогим витком, а не замер: красный кейс — довод
              не ставить модель на этап, зелёный зелёный этап не обещает (bench, ROADMAP). */}
          {effectiveModels.length > 0 ? (
            <div className="rounded border border-neutral-800 p-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void runProbe()}
                  disabled={probe.running}
                  className="rounded border border-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-800 disabled:text-neutral-500"
                >
                  {probe.running ? 'Проба идёт…' : 'Проверить модели пробой'}
                </button>
                <span className="text-xs text-neutral-500">
                  три микро-кейса tool-calling за секунды — доходит ли модель до вызова инструмента
                </span>
              </div>
              {probe.lines.length > 0 ? (
                <div className="mt-2 space-y-1 text-xs">
                  {probe.lines.map((l) => (
                    <div key={l.model} className="truncate" title={l.model}>
                      <span className="font-mono">{l.model}</span>
                      {l.error !== null ? (
                        <span className="ml-2 text-amber-300">проба не состоялась: {l.error}</span>
                      ) : l.cases === null ? (
                        <span className="ml-2 text-neutral-500">проверяется…</span>
                      ) : (
                        <span className="ml-2">
                          {l.cases.every((c) => c.ok) ? (
                            <span className="text-emerald-400">✅ {l.cases.length}/{l.cases.length}</span>
                          ) : (
                            <span className="text-red-300">
                              ❌{' '}
                              {l.cases
                                .filter((c) => !c.ok)
                                .map((c) => (c.env ? `${c.name} (среда)` : c.name))
                                .join(', ')}
                            </span>
                          )}
                        </span>
                      )}
                      {l.cases !== null && l.cases.some((c) => !c.ok) ? (
                        <div className="ml-2 mt-0.5 whitespace-pre-wrap text-neutral-500">
                          {l.cases
                            .filter((c) => !c.ok)
                            .map((c) => `— ${c.name}: ${c.detail}`)
                            .join('\n')}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
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
          <div className="flex items-baseline gap-2 rounded border border-neutral-800 px-3 py-2 text-xs text-neutral-400">
            <span className="shrink-0 truncate">
              {project?.name ?? '—'} · профиль {profile === '' ? '—' : profile}
            </span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-neutral-600"
              title={project?.projectRoot ?? ''}
            >
              {project?.projectRoot ?? ''}
            </span>
          </div>

          {/* Сводка перед стартом: подтверждение обязано показывать то, что реально
              запишется в виток, — эффективный профиль с учётом оверрайдов шага 2. */}
          <div className="rounded border border-neutral-800 p-3">
            <div className="mb-1 text-xs uppercase tracking-wide text-neutral-500">
              Уйдёт в работу
            </div>
            <div className="space-y-0.5 font-mono text-[11px] text-neutral-400">
              {config.stages.map((s) => {
                const models = (effectiveByStage[s.id] ?? []).join(' + ') || '—';
                return (
                  <div key={s.id} className="truncate" title={`${s.title}: ${models}`}>
                    {s.title.padEnd(12, ' ')} {models}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Похожие витки: история этого проекта под рукой, и начинать похожую задачу
              с подставленного текста быстрее, чем с перепечатывания. Клик заполняет
              поля, а не стартует виток — правка перед стартом остаётся за человеком. */}
          {similar.length > 0 ? (
            <div className="rounded border border-neutral-800 p-3">
              <div className="mb-1 text-xs uppercase tracking-wide text-neutral-500">
                Похожие витки из истории
              </div>
              <div className="space-y-1">
                {similar.map((e) => (
                  <button
                    key={e.slug}
                    type="button"
                    onClick={() => {
                      onSlugChange(uniqueSlug(e.slug, takenSlugs));
                      if (e.requirement === undefined) return;
                      // Набранный текст задачи не затирается молча: карточка обрезана, и
                      // по ней кликают в том числе чтобы прочитать её целиком — прежний
                      // абзац при этом терялся без отмены, вместе с черновиком (ревью).
                      const busy = requirement.trim() !== '' && requirement.trim() !== e.requirement.trim();
                      if (busy && !window.confirm('Заменить набранный текст задачи текстом этого витка?')) {
                        return;
                      }
                      onRequirementChange(e.requirement);
                    }}
                    className="block w-full rounded border border-neutral-800 px-2 py-1.5 text-left text-xs hover:border-neutral-600"
                  >
                    <span className="font-mono text-neutral-300">{e.slug}</span>
                    <span className="ml-2 text-neutral-600">
                      {historyStatusLabel(e.status)} · {e.updatedAt.slice(0, 10)}
                    </span>
                    {e.requirement !== undefined ? (
                      <span className="mt-0.5 block truncate text-neutral-500">
                        {e.requirement}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

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
            <span className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-neutral-500">
              Slug витка — имя каталога артефактов
              <button
                type="button"
                onClick={() => onSlugChange(uniqueSlug(generatedSlug, takenSlugs))}
                disabled={generatedSlug === ''}
                title="Сгенерировать из текста задачи"
                className="normal-case text-emerald-500 hover:text-emerald-400 disabled:text-neutral-600"
              >
                из текста задачи
              </button>
            </span>
            <input
              value={slug}
              onChange={(e) => onSlugChange(e.target.value)}
              placeholder="pay-412"
              className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-2 font-mono text-sm"
            />
          </label>

          {/* Занятость — предупреждение, а не блок: сервер разрешает продолжить виток
              в том же каталоге, и человек должен видеть цену этого решения. */}
          {slugTaken ? (
            <p className="text-xs text-amber-300">
              Виток «{slug.trim()}» уже есть в истории — артефакты продолжат писаться в тот
              же каталог .sdlc/{slug.trim()}/
            </p>
          ) : null}
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
