/**
 * Чистая логика дашборда запусков: порядок карточек, фильтры, сводка этапов, тон
 * артефакта, время. Компонентов раннер тестов не видит (React-раннера в проекте нет) —
 * всё, что решает, вынесено сюда.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STAGE_ORDER, emptyUsage } from '@sdlc-runner/shared';
import type { DashboardArtifact, DashboardCard, DashboardStage, DashboardStageState, RunSummary } from '@sdlc-runner/shared';

import { EMPTY_FILTER, applyFilter, isFilterEmpty, matchesQuery, parseFilter, projectOptions, serializeFilter } from '../src/lib/dashboardFilter.ts';
import { cardKey, cardPriority, sortCards } from '../src/lib/dashboardSort.ts';
import {
  artifactTone,
  defaultDetailStage,
  detailFreshnessKey,
  fmtBytes,
  formatStageSummary,
  groupArtifactsByStage,
  stageSummary,
} from '../src/lib/dashboardStages.ts';
import { SOURCE_LABEL } from '../src/lib/dashboardStatus.ts';
import { fmtUpdatedAt } from '../src/lib/dashboardTime.ts';
import { CIRCLE, STATE_LABEL, stageGlyph } from '../src/lib/stageTone.ts';
import type { StageTone } from '../src/lib/stageTone.ts';

function stages(states: Partial<Record<(typeof STAGE_ORDER)[number], DashboardStageState>> = {}): DashboardStage[] {
  return STAGE_ORDER.map((id) => ({ id, title: id, state: states[id] ?? 'notStarted', blamed: null, note: null, outputs: [] }));
}

function live(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'r',
    slug: 's',
    project: 'p',
    profile: 'x',
    status: 'running',
    stage: 'plan',
    chunk: 1,
    attempt: 1,
    attemptBudget: 3,
    usage: emptyUsage(),
    waiting: 0,
    stageStartedAt: null,
    ...over,
  };
}

function card(slug: string, over: Partial<DashboardCard> = {}): DashboardCard {
  return {
    ref: { source: 'ui', project: 'proj', slug },
    status: 'unfinished',
    updatedAt: '2026-09-20T10:00:00.000Z',
    chunk: 1,
    attempt: 1,
    stages: stages(),
    usage: null,
    live: null,
    bench: null,
    runCount: 0,
    ...over,
  };
}

describe('порядок карточек', () => {
  it('ждущий человека → идущий → остальные по свежести', () => {
    const cards = [
      card('old', { updatedAt: '2026-09-01T00:00:00.000Z' }),
      card('running', { live: live() }),
      card('fresh', { updatedAt: '2026-09-24T00:00:00.000Z' }),
      card('waiting', { live: live({ waiting: 2 }), updatedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    deepStrictEqual(
      sortCards(cards).map((c) => c.ref.slug),
      ['waiting', 'running', 'fresh', 'old'],
    );
    strictEqual(cards[0]?.ref.slug, 'old', 'вход не мутирован');
    strictEqual(cardPriority(card('a', { live: live({ status: 'awaiting' }) })), 0);
    strictEqual(cardKey({ source: 'bench', project: 'results', slug: 'x' }), 'bench/results/x');
  });
});

describe('фильтры', () => {
  const cards = [
    card('pay-1', { requirement: 'Починить округление НДС' }),
    card('bench-1', { ref: { source: 'bench', project: 'results', slug: 'bench-1' }, status: 'aborted', bench: { model: 'ollama:qwen', task: 'vat-rounding', mode: { kind: 'all' }, routes: {}, stopped: 'escalate', finalVerdict: null, startedAt: '', finishedAt: '', hasTrace: false, hasReport: false, inProgress: false } }),
    card('term-1', { ref: { source: 'terminal', project: 'WarCard', slug: 'term-1' }, status: 'done' }),
    card('live-1', { live: live({ waiting: 1 }) }),
  ];

  it('пустой фильтр пропускает всё; каждый критерий сужает', () => {
    strictEqual(applyFilter(cards, EMPTY_FILTER).length, 4);
    deepStrictEqual(applyFilter(cards, { ...EMPTY_FILTER, source: 'bench' }).map((c) => c.ref.slug), ['bench-1']);
    deepStrictEqual(applyFilter(cards, { ...EMPTY_FILTER, project: 'WarCard' }).map((c) => c.ref.slug), ['term-1']);
    deepStrictEqual(applyFilter(cards, { ...EMPTY_FILTER, status: 'done' }).map((c) => c.ref.slug), ['term-1']);
    deepStrictEqual(applyFilter(cards, { ...EMPTY_FILTER, status: 'waiting' }).map((c) => c.ref.slug), ['live-1']);
    deepStrictEqual(applyFilter(cards, { ...EMPTY_FILTER, status: 'live' }).map((c) => c.ref.slug), ['live-1']);
  });

  it('поиск: кириллица в задаче, модель и задача стенда, пробелы — не фильтр', () => {
    ok(matchesQuery(cards[0]!, 'ндс'));
    ok(matchesQuery(cards[1]!, 'QWEN'));
    ok(matchesQuery(cards[1]!, 'vat-round'));
    ok(!matchesQuery(cards[2]!, 'ндс'));
    ok(matchesQuery(cards[2]!, '   '));
  });

  it('варианты проекта — уникальные и по алфавиту', () => {
    deepStrictEqual(projectOptions(cards), ['proj', 'results', 'WarCard'].sort((a, b) => a.localeCompare(b)));
  });

  it('localStorage: туда и обратно; мусор и чужие значения — нейтральный фильтр', () => {
    const f = { project: 'p', source: 'terminal' as const, status: 'aborted' as const, query: 'x' };
    deepStrictEqual(parseFilter(serializeFilter(f)), f);
    deepStrictEqual(parseFilter('{ битое'), EMPTY_FILTER);
    deepStrictEqual(parseFilter(null), EMPTY_FILTER);
    deepStrictEqual(parseFilter(JSON.stringify({ source: 'cli', status: 'что-то' })), EMPTY_FILTER);
    ok(isFilterEmpty(EMPTY_FILTER));
    ok(!isFilterEmpty({ ...EMPTY_FILTER, query: 'a' }));
  });
});

describe('сводка этапов', () => {
  it('пропущенный этап закрыт; идущий важнее провала', () => {
    const s = stageSummary(stages({ intent: 'done', explore: 'done', ask: 'skipped', plan: 'failed', chunk: 'running' }));
    strictEqual(s.done, 3);
    strictEqual(formatStageSummary(s, { chunk: 'Chunk' }), '3 из 7 этапов · идёт Chunk');
    strictEqual(formatStageSummary(stageSummary(stages({ intent: 'done', explore: 'failed' }))), '1 из 7 этапов · провален explore');
    strictEqual(formatStageSummary(stageSummary(stages({ intent: 'blocked' }))), '0 из 7 этапов · стоит на intent');
  });

  it('этап деталей по умолчанию: идущий → проваленный → стоящий → последний пройденный', () => {
    strictEqual(defaultDetailStage(stages({ intent: 'done', explore: 'failed', ask: 'running' })), 'ask');
    strictEqual(defaultDetailStage(stages({ intent: 'done', explore: 'failed' })), 'explore');
    strictEqual(defaultDetailStage(stages({ intent: 'done', plan: 'done' })), 'plan');
    strictEqual(defaultDetailStage(stages()), 'intent');
  });

  it('ключ свежести меняется от живых полей, а не только от времени', () => {
    const a = card('x', { live: live({ waiting: 0 }) });
    const b = card('x', { live: live({ waiting: 1 }) });
    ok(detailFreshnessKey(a) !== detailFreshnessKey(b));
  });
});

function art(over: Partial<DashboardArtifact>): DashboardArtifact {
  return { name: 'plan.md', presence: 'filled', placeholders: 0, sizeBytes: 10, mtime: null, optional: false, decision: null, ...over };
}

describe('артефакты', () => {
  it('решение человека важнее содержимого; нет файла — нет решения', () => {
    strictEqual(artifactTone(art({ presence: 'placeholders', decision: { label: 'Одобрение', state: 'pending' } })), 'pending');
    strictEqual(artifactTone(art({ decision: { label: 'Одобрение', state: 'granted' } })), 'granted');
    strictEqual(artifactTone(art({ presence: 'missing', decision: { label: 'Одобрение', state: 'pending' } })), 'missing');
    strictEqual(artifactTone(art({ presence: 'placeholders' })), 'placeholders');
    strictEqual(artifactTone(art({})), 'ready');
  });

  it('группировка по этапам: общий файл — у первого этапа, пустые этапы опущены', () => {
    const s = stages();
    s[0]!.outputs = [art({ name: 'intent.md' }), art({ name: 'readiness.md' })];
    s[3]!.outputs = [art({ name: 'plan.md' }), art({ name: 'readiness.md' })];
    deepStrictEqual(
      groupArtifactsByStage(s).map((g) => [g.stage, g.items.map((a) => a.name)]),
      [
        ['intent', ['intent.md', 'readiness.md']],
        ['plan', ['plan.md']],
      ],
    );
  });

  it('размер для человека', () => {
    strictEqual(fmtBytes(null), '—');
    strictEqual(fmtBytes(512), '512 Б');
    strictEqual(fmtBytes(2048), '2.0 КБ');
  });
});

describe('время и тона', () => {
  it('свежее — относительно, старое — датой; мусор — как есть', () => {
    const now = Date.parse('2026-09-25T12:00:00.000Z');
    strictEqual(fmtUpdatedAt('2026-09-25T11:59:40.000Z', now), 'только что');
    strictEqual(fmtUpdatedAt('2026-09-25T11:45:00.000Z', now), '15 мин назад');
    strictEqual(fmtUpdatedAt('2026-09-25T09:00:00.000Z', now), '3 ч назад');
    ok(/^2026-09-2\d \d\d:\d\d$/.test(fmtUpdatedAt('2026-09-22T09:00:00.000Z', now)));
    strictEqual(fmtUpdatedAt('не дата', now), 'не дата');
  });

  it('у каждого состояния этапа — свой кружок и подпись; «пропущен» не «пройден»', () => {
    const tones: StageTone[] = ['done', 'running', 'available', 'blocked', 'skipped', 'notStarted', 'failed'];
    for (const t of tones) {
      ok(CIRCLE[t] !== '', `нет кружка у ${t}`);
      ok(STATE_LABEL[t].text !== '', `нет подписи у ${t}`);
    }
    ok(CIRCLE.failed.includes('red'));
    ok(STATE_LABEL.skipped.text !== STATE_LABEL.done.text);
    deepStrictEqual(
      tones.map((t) => stageGlyph(t, 2)),
      ['✓', '3', '3', '3', '–', '3', '✗'],
    );
    strictEqual(SOURCE_LABEL.terminal, 'терминал');
  });
});

describe('та же карточка и переиспользование', () => {
  it('смена источника терминал → UI — та же карточка; стенд — другая', async () => {
    const { sameCard } = await import('../src/lib/dashboardSort.ts');
    ok(sameCard({ source: 'terminal', project: 'p', slug: 's' }, { source: 'ui', project: 'p', slug: 's' }));
    ok(!sameCard({ source: 'bench', project: 'p', slug: 's' }, { source: 'ui', project: 'p', slug: 's' }));
    ok(!sameCard({ source: 'ui', project: 'p', slug: 's' }, { source: 'ui', project: 'p', slug: 't' }));
  });

  it('неизменная карточка остаётся тем же объектом, изменённая — новым', async () => {
    const { reuseCards } = await import('../src/lib/dashboardSort.ts');
    const a = card('a');
    const b = card('b');
    const next = reuseCards([a, b], [JSON.parse(JSON.stringify(a)), { ...JSON.parse(JSON.stringify(b)), status: 'done' }]);
    strictEqual(next[0], a);
    ok(next[1] !== b);
    strictEqual(reuseCards(null, [a])[0], a);
  });
});

describe('одно правило «где виток»', () => {
  it('два проваленных этапа — доска, сводка и деталь указывают на последний', async () => {
    const { boardPlace } = await import('../src/lib/dashboardBoard.ts');
    const st = stages({ intent: 'done', explore: 'failed', ask: 'done', plan: 'failed' });
    strictEqual(boardPlace({ stages: st, status: 'unfinished' }).column, 'plan');
    strictEqual(stageSummary(st).failed, 'plan');
    strictEqual(defaultDetailStage(st), 'plan');
  });
});
