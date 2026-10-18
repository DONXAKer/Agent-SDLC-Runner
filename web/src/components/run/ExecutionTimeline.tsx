import { useEffect, useRef, useState } from 'react';
import type { ExecutionEntry, ExecutionPage } from '@sdlc-runner/shared';
import { filterExecutionEntries, mergeExecutionEntries } from '../../lib/executionEntries.ts';

export function ExecutionTimeline({ runId, revision }: { runId: string; revision: number }) {
  const [entries, setEntries] = useState<ExecutionEntry[]>([]);
  const [page, setPage] = useState<ExecutionPage | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [stage, setStage] = useState('');
  const [item, setItem] = useState('');
  const [attempt, setAttempt] = useState('');
  const [now, setNow] = useState(Date.now());
  const cursor = useRef<number | null>(null);
  const refresh = useRef<(() => void) | null>(null);
  useEffect(() => {
    cursor.current = null; setEntries([]); setPage(null); setError('');
    let disposed = false; let busy = false;
    const read = async () => {
      if (busy || disposed) return; busy = true;
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/execution?limit=100${cursor.current === null ? '' : `&cursor=${cursor.current}`}`);
        if (!response.ok) throw new Error(`Журнал недоступен: HTTP ${response.status}`);
        const value = await response.json() as ExecutionPage;
        if (disposed) return;
        cursor.current = value.nextCursor; setPage(value); setError('');
        setEntries(previous => mergeExecutionEntries(previous, value.entries));
      } catch (cause) { if (!disposed) setError(String(cause)); }
      finally { busy = false; }
    };
    refresh.current = () => { void read(); };
    void read();
    const timer = setInterval(() => { setNow(Date.now()); void read(); }, 2000);
    return () => { disposed = true; clearInterval(timer); refresh.current = null; };
  }, [runId]);
  useEffect(() => { refresh.current?.(); }, [revision]);
  const shown = filterExecutionEntries(entries, { text: filter, stage, item, attempt });
  const summary = page?.summary;
  return <section className="space-y-3 rounded border border-neutral-800 p-3 text-xs" aria-label="Трассировка выполнения">
    <div className="flex flex-wrap gap-3"><strong>Ход выполнения</strong>
      <a href={`/api/runs/${encodeURIComponent(runId)}/execution.json`} download>Скачать JSON</a>
      <a href={`/api/runs/${encodeURIComponent(runId)}/flow.html`} target="_blank" rel="noreferrer">Открыть HTML-отчёт</a>
    </div>
    {error && <p role="alert" className="text-amber-300">{error}</p>}
    {summary?.limitations.map(text => <p key={text} className="text-amber-300">{text}</p>)}
    {summary && <>
      <p>Проверки: {summary.checks.passed} успешных / {summary.checks.failed} неуспешных. С первой проверки: {summary.checks.firstAttemptPassed}/{summary.checks.itemsChecked}. Повторы ошибки: {summary.repeatedFailures}. Откаты: {summary.rollbacks}. Прервано: {summary.interrupted}.</p>
      <p>До первого изменения: {summary.timeToFirstMutationMs === null ? 'неизвестно' : `${(summary.timeToFirstMutationMs / 1000).toFixed(1)} с`}. До успешной проверки: {summary.timeToFirstPassingCheckMs === null ? 'неизвестно' : `${(summary.timeToFirstPassingCheckMs / 1000).toFixed(1)} с`}. Неполных пакетов контекста: {summary.incompleteContexts}.</p>
      <p>Время инструментов: {(summary.toolDurationMs / 1000).toFixed(1)} с · Проверок: {(summary.checkDurationMs / 1000).toFixed(1)} с · Ответов человека: {(summary.humanWaitMs / 1000).toFixed(1)} с. Времена могут пересекаться и не складываются в длительность прогона.</p>
      {Object.keys(summary.failures).length > 0 && <p>Причины сбоев: {Object.entries(summary.failures).map(([reason, count]) => `${reason}: ${count}`).join(', ')}</p>}
      {summary.active.map(op => <p key={op.id}>Сейчас: {op.kind} · {op.itemId ?? 'этап'} · попытка {op.attempt} · {Math.max(0, Math.round((now - Date.parse(op.startedAt)) / 1000))} с</p>)}
      <table className="w-full text-left"><thead><tr><th>Назначение</th><th>Запросы</th><th>Токены вход/выход</th><th>Время модели</th><th>Стоимость</th></tr></thead>
        <tbody>{Object.entries(summary.byPurpose).map(([purpose, value]) => <tr key={purpose}><td>{purpose}</td><td>{value.requests ?? 'неизвестно'}</td><td>{value.inputTokens}/{value.outputTokens}</td><td>{(value.durationMs / 1000).toFixed(1)} с</td><td>{value.cost === null ? 'неизвестно' : `${value.cost.toFixed(4)} ${value.currency}`}</td></tr>)}</tbody></table>
    </>}
    <div className="flex flex-wrap gap-2">
      <input aria-label="Поиск по загруженным событиям" placeholder="Поиск по загруженным событиям" value={filter} onChange={e => setFilter(e.target.value)} className="bg-neutral-900 p-1" />
      <select aria-label="Этап трассы" value={stage} onChange={e => setStage(e.target.value)} className="bg-neutral-900"><option value="">Все этапы</option>{[...new Set(entries.map(e => e.stage).filter(Boolean))].map(s => <option key={s} value={s!}>{s}</option>)}</select>
      <input aria-label="Пункт работы" placeholder="Пункт работы" value={item} onChange={e => setItem(e.target.value)} className="bg-neutral-900 p-1" />
      <input aria-label="Попытка" placeholder="Попытка" value={attempt} onChange={e => setAttempt(e.target.value)} className="bg-neutral-900 p-1" />
      {page?.hasMore && <button onClick={() => refresh.current?.()}>Загрузить следующие события</button>}
    </div>
    <p>Загружено {entries.length}. Показаны последние {Math.min(shown.length, 100)} из {shown.length} подходящих событий. Полная история — в экспорте.</p>
    <div className="max-h-[600px] space-y-2 overflow-auto">{shown.slice(-100).reverse().map(entry => <details key={entry.id} id={`event-${entry.id}`} className="rounded bg-neutral-900 p-2">
      <summary>{entry.at} · {entry.stage} · {entry.kind} {entry.itemId ? `· ${entry.itemId} / ${entry.attempt}` : ''}</summary>
      <p>{entry.from} → {entry.to} · операция {entry.operationId ?? 'не записана'}</p>
      {entry.operationId && <button onClick={() => setFilter(entry.operationId!)}>Показать связанные события</button>}
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(entry.payload, null, 2)}</pre>
    </details>)}</div>
  </section>;
}
