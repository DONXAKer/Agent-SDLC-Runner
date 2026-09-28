import { useState } from 'react';
import type { ReactNode } from 'react';

import type { DashboardArtifact, DashboardCard, DashboardStageDetail, StageId } from '@sdlc-runner/shared';

import { fmtBytes } from '../../lib/dashboardStages.ts';
import { fmtCost, fmtDuration, fmtTokens } from '../../lib/format.ts';
import { FLOW_BADGE, STATE_LABEL } from '../../lib/stageTone.ts';
import { verdictTextTone, verdictTone } from '../../lib/tones.ts';
import { GatePanel } from '../GatePanel.tsx';
import { MarkdownOrSource } from '../Markdown.tsx';
import { CollapsibleSection } from '../run/CollapsibleSection.tsx';
import { ArtifactViewer, MarkedText } from './ArtifactViewer.tsx';

type Tab = 'input' | 'output' | 'info';

const TAB_LABEL: Record<Tab, string> = { input: 'Вход', output: 'Выход', info: 'Инфо' };

function tabBtn(active: boolean): string {
  return `rounded px-2.5 py-1 text-xs ${active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900'}`;
}

function Empty({ children }: { children: string }): JSX.Element {
  return <div className="mt-3 text-xs text-neutral-500">{children}</div>;
}

function contractNote(artifact: DashboardArtifact, optional = false): string | undefined {
  const parts = [
    optional ? 'необязательный вход' : null,
    artifact.purpose,
    artifact.origin === undefined ? null : `источник: ${artifact.origin}`,
    artifact.freshness === undefined ? null : `актуальность: ${artifact.freshness}`,
  ].filter((part): part is string => part !== null && part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** Размер в байтах UTF-8: длина строки — символы, а у русского текста байт почти вдвое больше. */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

function PromptBlock({ title, text }: { title: string; text: string }): JSX.Element {
  return (
    <CollapsibleSection title={title} summary={<span className="text-neutral-500">{fmtBytes(utf8Bytes(text))}</span>} compact defaultOpen={false}>
      {text === '' ? <div className="px-3 py-2 text-xs text-neutral-500">(пусто)</div> : <MarkdownOrSource text={text} source={<MarkedText text={text} />} topLevel={false} />}
    </CollapsibleSection>
  );
}

function InputTab({ card, stage }: { card: DashboardCard; stage: DashboardStageDetail }): JSX.Element {
  const prompt = stage.lastRun?.prompt ?? null;
  return (
    <div>
      <div className="mt-3 text-xs uppercase tracking-wide text-neutral-500">Входные артефакты</div>
      {stage.inputs.length === 0 ? (
        <Empty>
          {card.ref.source === 'bench'
            ? 'рабочая копия стенда удалена после прогона — входы видны только в промпте'
            : 'этап ничего не читает из каталога витка'}
        </Empty>
      ) : (
        stage.inputs.map((a) => (
          <ArtifactViewer key={a.name} cardRef={card.ref} artifact={a} {...(contractNote(a, a.optional) === undefined ? {} : { note: contractNote(a, a.optional) })} />
        ))
      )}

      <div className="mt-4 flex items-center gap-2 text-xs uppercase tracking-wide text-neutral-500">
        Промпт последнего прогона
        {prompt?.editedByOperator === true ? (
          <span className="rounded border border-amber-700 px-1.5 normal-case tracking-normal text-amber-300">с правкой оператора</span>
        ) : null}
      </div>
      {prompt === null ? (
        <Empty>
          {stage.lastRun === null
            ? card.ref.source === 'terminal'
              ? 'виток терминала: промпт в ленту раннера не записывался'
              : 'в ленте нет прогона этого этапа'
            : 'в прогоне нет записанного промпта'}
        </Empty>
      ) : (
        <>
          <PromptBlock title="Системный блок" text={prompt.system} />
          <PromptBlock title="Пользовательское сообщение" text={prompt.user} />
          {prompt.toolNames.length > 0 ? (
            <div className="mt-2 text-xs text-neutral-500">
              инструменты: <span className="font-mono text-neutral-400">{prompt.toolNames.join(', ')}</span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function OutputTab({ card, stage }: { card: DashboardCard; stage: DashboardStageDetail }): JSX.Element {
  const run = stage.lastRun;
  return (
    <div>
      <div className="mt-3 text-xs uppercase tracking-wide text-neutral-500">Артефакты этапа</div>
      {stage.outputs.length === 0 ? (
        <Empty>
          {card.ref.source === 'bench' ? 'файлы витка стенда не сохраняются — есть результат, отчёт и лента' : 'этап не пишет артефактов'}
        </Empty>
      ) : (
        stage.outputs.map((a) => <ArtifactViewer key={a.name} cardRef={card.ref} artifact={a} {...(contractNote(a) === undefined ? {} : { note: contractNote(a) })} />)
      )}

      <div className="mt-4 text-xs uppercase tracking-wide text-neutral-500">Ответ модели</div>
      {run === null || run.assistantText === '' ? (
        <Empty>{run === null ? 'в ленте нет прогона этого этапа' : 'модель не писала текста — только вызовы инструментов'}</Empty>
      ) : (
        <div className="mt-2 rounded border border-neutral-800">
          <MarkdownOrSource text={run.assistantText} source={<MarkedText text={run.assistantText} />} topLevel={false} />
        </div>
      )}
      {run?.outcome != null ? (
        <div className={`mt-2 text-xs ${run.outcome.ok ? 'text-emerald-400' : 'text-red-300'}`}>
          итог прогона: {run.outcome.ok ? 'ok' : 'не удался'}
          {run.outcome.note !== '' ? ` — ${run.outcome.note}` : ''}
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex gap-3 py-0.5 text-xs">
      <span className="w-36 shrink-0 text-neutral-500">{label}</span>
      <span className="min-w-0 break-words text-neutral-300">{children}</span>
    </div>
  );
}

function InfoTab({
  card,
  stage,
  titles,
}: {
  card: DashboardCard;
  stage: DashboardStageDetail;
  titles: Partial<Record<StageId, string>>;
}): JSX.Element {
  const run = stage.lastRun;
  const benchModel = card.bench?.routes[stage.id];
  const verdict = run?.verdict ?? null;
  return (
    <div className="mt-3">
      <Row label="Состояние">
        <span className={STATE_LABEL[stage.state].cls}>{STATE_LABEL[stage.state].text}</span>
        {stage.note !== null ? <span className="text-neutral-400"> — {stage.note}</span> : null}
        {stage.blamed !== null ? <span className="text-amber-300"> · виновник: {titles[stage.blamed] ?? stage.blamed}</span> : null}
      </Row>
      {run !== null && run.flow !== null ? (
        <Row label="Маршрут">
          <span className={`rounded px-1 py-0.5 text-[10px] ${FLOW_BADGE[run.flow]}`}>{run.flow}</span>{' '}
          <span className="font-mono">{run.provider} · {run.model}</span>
        </Row>
      ) : benchModel !== undefined ? (
        <Row label="Модель">
          <span className="font-mono">{benchModel}</span>
        </Row>
      ) : null}
      {stage.metrics !== null ? (
        <>
          <Row label="Прогонов этапа">{stage.metrics.runs}</Row>
          <Row label="Токены">
            {fmtTokens(stage.metrics.usage.inputTokens)} вход · {fmtTokens(stage.metrics.usage.outputTokens)} выход
            {stage.metrics.usage.cacheReadTokens > 0 ? ` · кэш ${fmtTokens(stage.metrics.usage.cacheReadTokens)}` : ''}
          </Row>
          <Row label="Стоимость">{fmtCost(stage.metrics.usage, card.currency)}</Row>
          <Row label="Длительность">{fmtDuration(stage.metrics.durationMs)}</Row>
        </>
      ) : (
        <Row label="Расход">{card.ref.source === 'terminal' ? 'виток терминала: чисел раннера нет' : 'этап не запускался'}</Row>
      )}
      {run !== null ? <Row label="Вызовов инструментов">{run.toolCalls}</Row> : null}
      {stage.benchRecord !== null ? (
        <Row label="Запись стенда">
          {stage.benchRecord.ok ? 'ok' : 'не ok'}
          {stage.benchRecord.closedBy === 'runtime' ? ' · закрыл рантайм' : ''}
          {stage.benchRecord.timedOut ? ' · таймаут' : ''}
          {stage.benchRecord.skipped ? ' · пропущен' : ''}
          {stage.benchRecord.turns !== null ? ` · ходов ${stage.benchRecord.turns}` : ''}
          {stage.benchRecord.modelRequests !== null ? ` · запросов ${stage.benchRecord.modelRequests}` : ''}
          {stage.benchRecord.envFailure !== null ? ` · отказ среды: ${stage.benchRecord.envFailure}` : ''}
          {stage.benchRecord.note !== '' ? <div className="text-neutral-400">{stage.benchRecord.note}</div> : null}
        </Row>
      ) : null}

      {run !== null && run.gates.length > 0 ? <GatePanel results={run.gates} aborted={false} compact={false} /> : null}

      {verdict !== null ? (
        <div className={`mt-3 rounded border p-3 text-xs ${verdictTone(verdict.passed)}`}>
          <div className={`mb-1 font-medium ${verdictTextTone(verdict.passed)}`}>
            Вердикт прогона: {verdict.passed ? 'passed' : 'не пройден'} · {verdict.action}
          </div>
          <ul className="space-y-0.5 text-neutral-300">
            {verdict.reasons.map((r, i) => (
              <li key={i} className="whitespace-pre-wrap break-words">
                — {r}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {stage.id === 'verify' || stage.id === 'handoff' ? (
        stage.storedVerdict !== null ? (
          <Row label="Вердикт рантайма">
            <span className={verdictTextTone(stage.storedVerdict.passed)}>
              {stage.storedVerdict.passed ? 'попытка принята' : `не принята · ${stage.storedVerdict.action}`}
            </span>
            {stage.storedVerdict.committedSha !== null ? <span className="font-mono text-neutral-400"> · коммит {stage.storedVerdict.committedSha.slice(0, 10)}</span> : null}
          </Row>
        ) : card.ref.source !== 'bench' ? (
          <Row label="Вердикт рантайма">
            <span className="text-neutral-500">на этой машине нет — строка passed отчёта вердиктом не считается</span>
          </Row>
        ) : null
      ) : null}

      {stage.blockers.length > 0 ? (
        <div className="mt-3">
          <div className="text-xs uppercase tracking-wide text-neutral-500">Условия входа сейчас не выполнены</div>
          <ul className="mt-1 space-y-1 text-xs text-neutral-300">
            {stage.blockers.map((b, i) => (
              <li key={i} className="whitespace-pre-wrap break-words">
                — {b.text}
                {b.blamed !== null ? <span className="text-amber-300"> (виновник: {titles[b.blamed] ?? b.blamed})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {(stage.runtimeFacts?.length ?? 0) > 0 ? (
        <div className="mt-3">
          <div className="text-xs uppercase tracking-wide text-neutral-500">Факты рантайма во входе этапа</div>
          <ul className="mt-1 space-y-1 text-xs text-neutral-300">
            {(stage.runtimeFacts ?? []).map((fact) => <li key={fact.id}><span className="font-mono">{fact.id}</span> — {fact.purpose} <span className="text-neutral-500">({fact.freshness})</span></li>)}
          </ul>
        </div>
      ) : null}
      {run !== null && run.errors.length > 0 ? (
        <div className="mt-3 text-xs text-red-300">
          {run.errors.map((e, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              ошибка: {e}
            </div>
          ))}
        </div>
      ) : null}
      {run !== null && run.warnings.length > 0 ? (
        <div className="mt-2 text-xs text-amber-300">
          {run.warnings.map((w, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              предупреждение: {w}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function StageDetail({
  card,
  stage,
  titles,
}: {
  card: DashboardCard;
  stage: DashboardStageDetail;
  titles: Partial<Record<StageId, string>>;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('output');
  const untouched = stage.state === 'notStarted' && stage.lastRun === null && stage.outputs.every((a) => a.presence === 'missing');
  return (
    <section className="rounded border border-neutral-800 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">{stage.title}</h2>
        <span className={`text-[10px] uppercase tracking-wide ${STATE_LABEL[stage.state].cls}`}>{STATE_LABEL[stage.state].text}</span>
        <div className="ml-auto flex gap-1">
          {(['input', 'output', 'info'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={tabBtn(tab === t)}>
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
      {untouched && tab === 'output' ? (
        <Empty>этап не запускался</Empty>
      ) : tab === 'input' ? (
        <InputTab card={card} stage={stage} />
      ) : tab === 'output' ? (
        <OutputTab card={card} stage={stage} />
      ) : (
        <InfoTab card={card} stage={stage} titles={titles} />
      )}
    </section>
  );
}
