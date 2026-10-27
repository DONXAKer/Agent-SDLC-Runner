import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ArchivedRunView } from './pages/ArchivedRunView.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { api } from './lib/api.ts';
import { formatHash, parseHash } from './lib/hashRoute.ts';
import type { Route } from './lib/hashRoute.ts';
import { readLS, writeLS } from './lib/persist.ts';
import type { ConfigInfo, DashboardCardRef, HistoryEntry, ProjectInfo, StageId } from '@sdlc-runner/shared';

/**
 * Черновик витка между перезагрузками страницы. Живёт в localStorage (`persist.ts`):
 * F5 посреди набранной задачи раньше затирал её без предупреждения — минуты ручной
 * работы пропадали одной перезагрузкой. Проект и профиль — предпочтения (не сбрасываются
 * после старта), slug/задача/оверрайды — черновик (сбрасываются после успешного старта).
 */
interface RunDraft {
  project: string | null;
  profile: string;
  slug: string;
  requirement: string;
  stageOverrides: Partial<Record<StageId, string>>;
}

const DRAFT_KEY = 'runDraft';

function readDraft(): RunDraft | null {
  const raw = readLS(DRAFT_KEY);
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw) as Partial<RunDraft>;
    return {
      project: typeof p.project === 'string' ? p.project : null,
      profile: typeof p.profile === 'string' ? p.profile : '',
      slug: typeof p.slug === 'string' ? p.slug : '',
      requirement: typeof p.requirement === 'string' ? p.requirement : '',
      stageOverrides:
        p.stageOverrides !== null && typeof p.stageOverrides === 'object'
          ? p.stageOverrides
          : {},
    };
  } catch {
    return null;
  }
}

export default function App(): JSX.Element {
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  /** Адрес сохраняет открытый экран и карточку деталей между перезагрузками. */
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [draft] = useState<RunDraft | null>(() => readDraft());
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [profile, setProfile] = useState('');
  const [slug, setSlug] = useState(() => draft?.slug ?? '');
  /** Задача витка: набирается в мастере, уходит на этап intent и правится уже там. */
  const [requirement, setRequirement] = useState(() => draft?.requirement ?? '');
  const [error, setError] = useState<string | null>(null);
  /** Виток только что заведён: поля мастера чистятся следующим проходом. */
  const [started, setStarted] = useState(false);
  const runRequirements = useRef(new Map<string, string>());
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  /** Правка моделей на один виток: на диск не сохраняется. */
  const [stageOverrides, setStageOverrides] = useState<Partial<Record<StageId, string>>>(
    () => draft?.stageOverrides ?? {},
  );

  // Кнопки «назад»/«вперёд» браузера и ручная правка адреса — такой же вход, как наши
  // переходы: слушаем событие, а не только пишем hash.
  useEffect(() => {
    const onHash = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((next: Route): void => {
    // Стейт ставится сразу, не дожидаясь `hashchange`: браузер не шлёт событие,
    // если hash не изменился, и повторный переход на тот же экран не должен зависать.
    setRoute(next);
    window.location.hash = formatHash(next);
  }, []);

  const stageTitles = useMemo(() => Object.fromEntries((config?.stages ?? []).map((s) => [s.id, s.title])), [config?.stages]);
  const openDashboardCard = useCallback((card: DashboardCardRef) => navigate({ kind: 'dashboard', card }), [navigate]);
  const goToDashboard = useCallback(() => navigate({ kind: 'dashboard', card: null }), [navigate]);
  const openLiveRun = useCallback((runId: string) => navigate({ kind: 'run', runId, view: 'now' }), [navigate]);
  const openArchivedRun = useCallback((project: string, slug: string) => navigate({ kind: 'archive', project, slug }), [navigate]);

  useEffect(() => {
    api
      .config()
      .then((c) => {
        setConfig(c);
        // Черновик помнит проект и профиль: возвращение к набранной задаче после F5
        // восстанавливает выбор, а не сбрасывает его на первый проект конфигурации.
        // Профиль из черновика берём только если он ещё существует у выбранного проекта.
        const p =
          c.projects.find((x) => x.name === draft?.project) ?? c.projects[0] ?? null;
        setProject(p);
        const draftProfile = p?.profiles.some((x) => x.name === draft?.profile)
          ? draft?.profile
          : undefined;
        setProfile(draftProfile ?? p?.activeProfile ?? '');
      })
      .catch((e: Error) => setError(e.message));
  }, [draft]);

  // Черновик пишем на каждое изменение, но только после загрузки конфигурации: до неё
  // поля стоят на дефолтах и перезаписали бы сохранённое значение пустым.
  useEffect(() => {
    if (config === null) return;
    const next: RunDraft = {
      project: project?.name ?? null,
      profile,
      slug,
      requirement,
      stageOverrides,
    };
    writeLS(DRAFT_KEY, JSON.stringify(next));
  }, [config, project?.name, profile, slug, requirement, stageOverrides]);

  // Ошибка старта черновик не трогает. После успеха текст также сохранён по runId,
  // поэтому мастер можно очистить, не теряя задачу до перехода в живое управление.
  useEffect(() => {
    if (!started) return;
    setStarted(false);
    setSlug('');
    setRequirement('');
    setStageOverrides({});
  }, [started]);

  const refreshHistory = useCallback(() => {
    if (project === null) {
      setHistory(null);
      return;
    }
    api.history(project.name).then(setHistory).catch((e: Error) => setError(e.message));
  }, [project]);

  useEffect(() => {
    if (route.kind === 'dashboard') refreshHistory();
  }, [route.kind, refreshHistory]);

  const addProject = async (name: string, path: string): Promise<ProjectInfo | null> => {
    setError(null);
    try {
      const p = await api.addProject(name, path);
      // Ответ уже содержит весь новый проект — полный перезапрос /api/config не нужен.
      setConfig((c) => (c === null ? c : { ...c, projects: [...c.projects, p] }));
      setProject(p);
      setProfile(p.activeProfile);
      return p;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  const start = async (): Promise<boolean> => {
    if (project === null || slug.trim() === '') return false;
    const startedProject = project.name;
    const startedSlug = slug.trim();
    const startedRequirement = requirement;
    setError(null);
    try {
      const r = await api.createRun(startedProject, startedSlug, profile, stageOverrides);
      runRequirements.current.set(r.runId, startedRequirement);
      await api.runStage(r.runId, 'intent', { requirement: startedRequirement });
      setStarted(true);
      navigate({ kind: 'dashboard', card: { source: 'ui', project: startedProject, slug: startedSlug } });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  if (route.kind === 'run') {
    return (
      <RunPage
        runId={route.runId}
        view={route.view}
        tab={route.view === 'obs' ? route.tab : 'events'}
        onViewChange={(view, tab) =>
          navigate(
            view === 'obs'
              ? { kind: 'run', runId: route.runId, view: 'obs', tab: tab ?? 'events' }
              : { kind: 'run', runId: route.runId, view: 'now' },
          )
        }
        initialRequirement={runRequirements.current.get(route.runId) ?? ''}
        onExit={goToDashboard}
        onOpenDashboard={goToDashboard}
      />
    );
  }

  if (route.kind === 'archive') {
    return (
      <ArchivedRunView
        project={route.project}
        slug={route.slug}
        stageTitles={stageTitles}
        onExit={goToDashboard}
        onOpenDashboard={goToDashboard}
      />
    );
  }

  return (
    <DashboardPage
      card={route.card}
      stageTitles={stageTitles}
      error={error}
      newRun={config === null ? null : {
        config,
        project,
        profile,
        stageOverrides,
        requirement,
        slug,
        history,
        onProjectChange: setProject,
        onProfileChange: setProfile,
        onStageOverridesChange: setStageOverrides,
        onRequirementChange: setRequirement,
        onSlugChange: setSlug,
        onAddProject: addProject,
      }}
      onStart={start}
      onOpenCard={openDashboardCard}
      onCloseCard={goToDashboard}
      onOpenLive={openLiveRun}
      onOpenArchive={openArchivedRun}
    />
  );
}
