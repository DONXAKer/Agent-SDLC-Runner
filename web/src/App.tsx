import { useCallback, useEffect, useState } from 'react';

import { ArchivedRunView } from './pages/ArchivedRunView.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { StartPage } from './pages/StartPage.tsx';
import { api } from './lib/api.ts';
import { formatHash, parseHash } from './lib/hashRoute.ts';
import type { Route } from './lib/hashRoute.ts';
import type { ConfigInfo, HistoryEntry, ProjectInfo, RunSummary, StageId } from '@sdlc-runner/shared';

export default function App(): JSX.Element {
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  /**
   * Какой экран открыт — в адресе, а не только в памяти.
   *
   * Раньше это были два `useState` (`runId` и `archived`), и F5 посреди работающего витка
   * возвращал на стартовый экран. `#/run/<id>` после перезапуска сервера мягко деградирует:
   * прогонов в памяти нет, `RunPage` показывает «← к списку витков».
   */
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [profile, setProfile] = useState('');
  const [slug, setSlug] = useState('');
  /** Задача витка: набирается на старте, уходит на этап intent и правится уже там. */
  const [requirement, setRequirement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  /** Правка моделей на один виток: на диск не сохраняется. */
  const [stageOverrides, setStageOverrides] = useState<Partial<Record<StageId, string>>>({});

  // Кнопки «назад»/«вперёд» браузера и ручная правка адреса — такой же вход, как наши
  // переходы: слушаем событие, а не только пишем hash.
  useEffect(() => {
    const onHash = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((next: Route): void => {
    // Стейт ставится сразу, не дожидаясь `hashchange`: браузер не шлёт событие, если hash
    // не изменился (например «на старт» со старта), и экран замер бы.
    setRoute(next);
    window.location.hash = formatHash(next);
  }, []);

  useEffect(() => {
    api
      .config()
      .then((c) => {
        setConfig(c);
        const first = c.projects[0] ?? null;
        setProject(first);
        setProfile(first?.activeProfile ?? '');
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const refreshRuns = useCallback(() => {
    // Ошибку здесь НЕ гасим: слот один на всё окно, и успешный фоновый список затёр бы
    // отказ загрузки конфигурации — экран остался бы «Загрузка конфигурации…» без причины.
    // Гасит тот, кто начинает действие: см. `setError(null)` в обработчиках.
    api.runs().then(setRuns).catch((e: Error) => setError(e.message));
  }, []);

  // История — с диска и per-project (в отличие от `runs`, общего списка живых прогонов
  // сервера сразу по всем проектам), поэтому перезапрашивается и при смене проекта.
  const refreshHistory = useCallback(() => {
    if (project === null) {
      setHistory(null);
      return;
    }
    api.history(project.name).then(setHistory).catch((e: Error) => setError(e.message));
  }, [project]);

  // Перезапрашивается и при возврате из витка: выход со страницы прогона — единственный
  // момент, когда список заведомо устарел, а раньше возвращаться было попросту некуда.
  // Условие включает и архивный просмотр — иначе список фонового `fetch`ился бы, пока
  // оператор читает read-only ленту `ArchivedRunView`, без всякой пользы для этого экрана.
  useEffect(() => {
    if (route.kind === 'start') {
      refreshRuns();
      refreshHistory();
    }
  }, [route.kind, refreshRuns, refreshHistory]);

  const forget = async (id: string): Promise<void> => {
    setError(null);
    try {
      await api.forget(id);
      refreshRuns();
    } catch (e) {
      // Сервер отказывает, пока этап выполняется, — причину показываем дословно, иначе
      // кнопка выглядит сломанной.
      setError((e as Error).message);
    }
  };

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

  const start = async (): Promise<void> => {
    if (project === null || slug.trim() === '') return;
    setError(null);
    try {
      const r = await api.createRun(project.name, slug.trim(), profile, stageOverrides);
      navigate({ kind: 'run', runId: r.runId });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (route.kind === 'run') {
    return (
      <RunPage
        runId={route.runId}
        initialRequirement={requirement}
        onExit={() => navigate({ kind: 'start' })}
      />
    );
  }

  if (route.kind === 'archive') {
    return (
      <ArchivedRunView
        project={route.project}
        slug={route.slug}
        stageTitles={Object.fromEntries((config?.stages ?? []).map((s) => [s.id, s.title]))}
        onExit={() => navigate({ kind: 'start' })}
      />
    );
  }

  if (config === null) {
    return (
      <div className="mx-auto max-w-2xl p-8 text-sm text-neutral-500">
        {error ?? 'Загрузка конфигурации…'}
      </div>
    );
  }

  return (
    <StartPage
      config={config}
      error={error}
      runs={runs}
      history={history}
      project={project}
      profile={profile}
      slug={slug}
      requirement={requirement}
      stageOverrides={stageOverrides}
      onProjectChange={setProject}
      onProfileChange={setProfile}
      onSlugChange={setSlug}
      onRequirementChange={setRequirement}
      onStageOverridesChange={setStageOverrides}
      onOpenRun={(runId) => navigate({ kind: 'run', runId })}
      onOpenHistory={(s) => {
        // Живой виток открывается как раньше (`RunPage`, WS, полное управление); для всего
        // остального (done/aborted/unfinished — и теперь тоже open, если почему-то разошёлся
        // со списком `runs`) единственный источник — архивная лента с диска, read-only.
        const r = runs?.find((x) => x.slug === s && x.project === project?.name);
        if (r !== undefined) navigate({ kind: 'run', runId: r.runId });
        else if (project !== null) navigate({ kind: 'archive', project: project.name, slug: s });
      }}
      onForget={(id) => void forget(id)}
      onRefreshRuns={() => {
        // Обновление по кнопке — действие человека, и оно вправе снять свою же прошлую
        // ошибку (например отказ «Убрать» с кодом 409).
        setError(null);
        refreshRuns();
      }}
      onRefreshHistory={() => {
        setError(null);
        refreshHistory();
      }}
      onAddProject={addProject}
      onStart={() => void start()}
    />
  );
}
