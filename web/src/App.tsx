import { useEffect, useState } from 'react';

import { DirectoryBrowser } from './components/DirectoryBrowser.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { api } from './lib/api.ts';
import type { ConfigInfo, ProjectInfo } from '@sdlc-runner/shared';

export default function App(): JSX.Element {
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [profile, setProfile] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

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

  const addProject = async (): Promise<void> => {
    if (pendingPath === null || newName.trim() === '') return;
    setError(null);
    try {
      const p = await api.addProject(newName.trim(), pendingPath);
      setPendingPath(null);
      setNewName('');
      // Ответ уже содержит весь новый проект — полный перезапрос /api/config не нужен.
      setConfig((c) => (c === null ? c : { ...c, projects: [...c.projects, p] }));
      setProject(p);
      setProfile(p.activeProfile);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (runId !== null) return <RunPage runId={runId} onExit={() => setRunId(null)} />;

  const start = async (): Promise<void> => {
    if (project === null || slug.trim() === '') return;
    setError(null);
    try {
      const r = await api.createRun(project.name, slug.trim(), profile);
      setRunId(r.runId);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="mb-1 text-xl font-medium">Agent-SDLC Runner</h1>
      <p className="mb-6 text-sm text-neutral-400">
        Один виток: цель → разведка → вопросы → план → chunk → верификация → передача.
        Артефакты пишутся в <code className="font-mono">.sdlc/&lt;slug&gt;/</code> целевого проекта.
      </p>

      {error !== null ? (
        <div className="mb-4 whitespace-pre-wrap rounded border border-red-800 bg-red-950/30 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {config === null ? (
        <div className="text-sm text-neutral-500">Загрузка конфигурации…</div>
      ) : (
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-xs uppercase tracking-wide text-neutral-500">
              <span>Проект</span>
              {config.browseEnabled ? (
                <button
                  type="button"
                  onClick={() => setBrowsing(true)}
                  className="normal-case text-emerald-500 hover:text-emerald-400"
                >
                  + добавить обзором каталогов
                </button>
              ) : null}
            </span>
            <select
              value={project?.name ?? ''}
              onChange={(e) => {
                const p = config.projects.find((x) => x.name === e.target.value) ?? null;
                setProject(p);
                setProfile(p?.activeProfile ?? '');
                // Панель добавления проекта относится к обзору каталогов, а не к выбору
                // из списка — оставленная висеть под уже другим проектом сбивает с толку.
                setPendingPath(null);
                setNewName('');
              }}
              className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm"
            >
              {config.projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} — {p.projectRoot}
                </option>
              ))}
            </select>
          </label>

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

          <div>
            <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
              Профиль — переводит весь виток целиком
            </span>
            <div className="grid gap-2 sm:grid-cols-2">
              {(project?.profiles ?? []).map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => setProfile(p.name)}
                  className={`rounded border p-3 text-left text-sm transition ${
                    profile === p.name
                      ? 'border-emerald-600 bg-emerald-950/30'
                      : 'border-neutral-800 hover:border-neutral-600'
                  }`}
                >
                  <div className="font-medium">{p.label}</div>
                  <div className="mt-1 space-y-0.5 font-mono text-[11px] text-neutral-500">
                    {Object.entries(p.stages).map(([s, m]) => (
                      <div key={s}>
                        {s.padEnd(8, ' ')} {m}
                      </div>
                    ))}
                  </div>
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              Виток не стартует, если модель на <code className="font-mono">verify</code> не
              строго сильнее модели на <code className="font-mono">chunk</code>: ревью слабее
              исполнителя — декорация, а «Ревью независимым агентом» входит в минимальную
              пятёрку гейтов и выключателя не имеет.
            </p>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">
              Slug витка — имя каталога артефактов
            </span>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="pay-412"
              className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-2 font-mono text-sm"
            />
          </label>

          <button
            type="button"
            onClick={() => void start()}
            disabled={slug.trim() === ''}
            className="rounded bg-emerald-700 px-4 py-2 text-sm font-medium hover:bg-emerald-600 disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            Начать виток
          </button>
        </div>
      )}
    </div>
  );
}
