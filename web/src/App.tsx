import { useEffect, useState } from 'react';

import { RunPage } from './pages/RunPage.tsx';
import { api } from './lib/api.ts';
import type { ConfigInfo, ProjectInfo } from './lib/types.ts';

export default function App(): JSX.Element {
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [profile, setProfile] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);

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
            <span className="mb-1 block text-xs uppercase tracking-wide text-neutral-500">Проект</span>
            <select
              value={project?.name ?? ''}
              onChange={(e) => {
                const p = config.projects.find((x) => x.name === e.target.value) ?? null;
                setProject(p);
                setProfile(p?.activeProfile ?? '');
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
