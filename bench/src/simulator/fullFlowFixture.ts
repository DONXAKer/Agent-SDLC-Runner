/** Герметичный протокольный fixture legacy v1; не копия текущей методологии. Реальные Run, инструменты и гейты. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { RunEvent, StageId } from '@sdlc-runner/shared';
import { STAGE_ORDER } from '@sdlc-runner/shared';
import { AskGate } from '../../../server/src/approval/askGate.ts';
import { ApprovalGate } from '../../../server/src/approval/gate.ts';
import type { LoadedConfig } from '../../../server/src/config/load.ts';
import type { ProjectConfig, ResolvedProfile, ResolvedRoute } from '../../../server/src/config/schema.ts';
import { Run } from '../../../server/src/run/Run.ts';

const GATES = [
  '# Набор гейтов: demo',
  '',
  '## Набор',
  '',
  '| Гейт | Вкл | Где отчитывается | Чем реализован |',
  '|---|---|---|---|',
  // Команда обязана быть исполнимой и разрешённой полом безопасности: прежний однострочник
  // `node -e …` отклонялся `denyList` и на прогоне давал ⏭, а preflight набора теперь не
  // пускает такой набор на chunk вовсе — эталон гонял бы витки, которые не стартуют.
  '| Сборка | да — минимум | этап 6 | `node --version` |',
  '| Тесты | да — минимум | этап 6 | `node --version` |',
  '| Scope: файлы вне плана | да — минимум | этап 6 | скрипт сверки diff с files_to_touch |',
  '| Анти-обход тест-гейта | да — минимум | этап 6 | скрипт |',
  '| Ревью независимым агентом | да — минимум | этап 6 | независимый квалифицированный агент |',
  '',
].join('\n');

const TEMPLATES: Record<string, string> = {
  'intent.template.md': [
    '# Задача: ‹название›',
    '',
    '- **Контур:** ‹полный / мелкий›',
    '- **Ветка витка:** ‹sdlc/слаг›',
    '',
    '## Приёмка',
    '',
    '| id | Пункт | Как проверить |',
    '|---|---|---|',
    '| claim-1 | ‹поведение› | ‹критерий› |',
    '',
  ].join('\n'),
  'readiness.template.md': '# Готовность: ‹название витка›\n\n- Прогон 1: ‹итог›\n',
  'plan.template.md': [
    '# План: ‹название витка›',
    '',
    '- **Требования (SHA-256):** ‹sha256 требований›',
    '- **Одобрение:** ‹подпись и дата›',
    '',
    '## files_to_touch',
    '',
    '| Путь | Что делаем |',
    '|---|---|',
    '| ‹путь› | ‹что› |',
    '',
  ].join('\n'),
  'chunk-journal.template.md': [
    '# Журнал chunk 1',
    '',
    '- **Подтвердил:** ‹подпись и дата›',
    '',
    '## Что сделано',
    '',
    '‹что сделано›',
    '',
  ].join('\n'),
  'verification-report.template.md': [
    '# Отчёт приёмки: ‹название витка›',
    '',
    '## Гейты',
    '',
    '| Гейт | Статус | Результат |',
    '|---|---|---|',
    '| Сборка | ‹статус› | ‹итог› |',
    '',
    '## 1. Пункты приёмки',
    '',
    '| id | Пункт | passed | Чем подтверждён | Что чинить |',
    '|---|---|---|---|---|',
    '| claim-1 | ‹пункт› | ‹статус› | ‹чем› | ‹что› |',
    '',
    // Секция вердикта — как в шаблоне эталона: копию вердикта в неё пишет рантайм, и без
    // неё сквозной эталон покрывал только путь «копия не легла».
    '## Вердикт',
    '',
    '- **passed:** true / false',
    '- **action:** continue / retry / blocked_env / escalate',
    '',
  ].join('\n'),
  'handoff.template.md': '# Передача: ‹название витка›\n\n- **Приёмка:** ‹подпись и дата›\n\n## Итог\n\n‹итог›\n',
  'exploration-report.template.md': [
    '# Отчёт разведки: ‹название витка›',
    '',
    '## Карта кодовой базы',
    '',
    '| Файл | Что там сейчас | Что меняем |',
    '|---|---|---|',
    '| ‹путь› | ‹что› | ‹что› |',
    '',
    '**Решение человека о полноте:** ‹подпись и дата›',
    '',
  ].join('\n'),
};

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'bench',
      GIT_AUTHOR_EMAIL: 'bench@example.com',
      GIT_COMMITTER_NAME: 'bench',
      GIT_COMMITTER_EMAIL: 'bench@example.com',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  });
}

function makeProject(gates: string = GATES, reviewer = false, files: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-simulator-flow-')));
  try {
  for (const stage of STAGE_ORDER) {
    mkdirSync(join(root, 'skills', `sdlc-${stage}`), { recursive: true });
    writeFileSync(join(root, 'skills', `sdlc-${stage}`, 'SKILL.md'), `СКИЛЛ ${stage}: заполни артефакт этапа по форме.\n`);
  }
  mkdirSync(join(root, 'methodology', 'templates'), { recursive: true });
  for (const [name, text] of Object.entries(TEMPLATES)) writeFileSync(join(root, 'methodology', 'templates', name), text);
  mkdirSync(join(root, 'agents'), { recursive: true });
  // Определение рецензента: без него рантайм ревью не запускает, и гейт минимума остаётся ⏭.
  // Подменный endpoint выбирает очередь по имени модельного маршрута verify.
  if (reviewer) {
    writeFileSync(
      join(root, 'agents', 'sdlc-reviewer.md'),
      '---\nname: sdlc-reviewer\ndescription: независимый рецензент\ntools: Read, Grep, Glob\n---\nРЕЦЕНЗЕНТ: опровергни, что сделано нужное.\n',
    );
  }
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.js'), 'export const version = 1;\n');
  mkdirSync(join(root, '.sdlc'), { recursive: true });
  writeFileSync(join(root, '.sdlc', 'gates.md'), gates);
  writeFileSync(join(root, '.gitignore'), 'skills/\nmethodology/\nagents/\n');
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'база');
  git(root, 'checkout', '-q', '-b', 'sdlc/demo');
  return root;
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}


function makeRun(
  root: string,
  baseUrl: string,
  events: RunEvent[],
  routeOver: Partial<ResolvedRoute> = {},
  ensembleOver: readonly Partial<ResolvedRoute>[] = [],
  runOptions: { guided?: boolean; engineVersion?: 4 | 5 } = {},
): Run {
  const guidedProvider = 'simulator_guided';
  const route = (stage: StageId): ResolvedRoute => ({
    stage,
    provider: runOptions.guided ? guidedProvider : `simulator_${crypto.randomUUID().replaceAll('-', '')}`,
    providerDef: { flow: 'loop', kind: 'openai-compat', baseUrl },
    model: runOptions.guided ? 'scripted-guided' : stage,
    modelId: runOptions.guided ? 'scripted-guided' : stage,
    flow: 'loop',
    rank: 1,
    params: null,
    leanTools: false,
    formFill: false,
    claimFill: false,
    reviewFill: false,
    skipTurnAfterReviewFill: false,
    planAxisFill: false,
    stepFill: false,
    stepContext: false,
    compactForms: 'off',
    exploreIndex: false,
    exploreFill: false,
    ...routeOver,
  });
  const routes = Object.fromEntries(STAGE_ORDER.map((s) => [s, route(s)])) as Record<StageId, ResolvedRoute>;
  const ensemble = Object.fromEntries(STAGE_ORDER.map((s) => [s, [routes[s]]])) as Record<StageId, ResolvedRoute[]>;
  // Дополнительные маршруты ансамбля — только у этапа 6: на пишущих этапах рантайм их не запускает.
  ensemble.verify = [routes.verify, ...ensembleOver.map((o, i) => ({ ...route('verify'), model: `m${i + 2}`, modelId: `m${i + 2}`, ...o }))];
  const profile: ResolvedProfile = { name: 'demo', label: 'demo', routes, ensemble };
  const project: ProjectConfig = { name: 'demo', projectRoot: root, activeProfile: 'demo', maxBudgetUsd: 1, profiles: {} };
  const config = {
    runner: {
      port: 0,
      operator: 'Симулятор',
      skillsDir: join(root, 'skills'),
      agentsDir: join(root, 'agents'),
      methodologyDir: join(root, 'methodology'),
      ...(runOptions.guided ? { reviewModel: 'simulator:reviewer' } : {}),
      limits: {
        maxToolResultBytes: 4000,
        localMaxToolResultBytes: 4000,
        readRangeRequiredAboveBytes: 4000,
        maxIterationsPerStage: runOptions.guided ? 40 : 8,
        gateTimeoutMs: 10_000,
        progressClosenessWarn: 0.9,
        chatTimeoutMs: 10_000,
      },
    },
    models: runOptions.guided ? { providers: { [guidedProvider]: { flow: 'loop', kind: 'openai-compat', baseUrl } },
      models: [{ id: 'simulator:reviewer', provider: guidedProvider, model: 'scripted-reviewer', rank: 1,
        contextWindow: 32768, reviewFill: true, claimFill: true }] } : { models: [] },
    projects: new Map(),
    mcp: new Map(),
  } as unknown as LoadedConfig;

  // Оператор-автомат: каждая запись одобряется сразу, как только гейт её предъявил.
  let gate: ApprovalGate | null = null;
  gate = new ApprovalGate({
    onPending: (p) => {
      setImmediate(() => gate?.resolve(p.runId, p.requestId, { allowed: true, updatedInput: null, by: 'operator' }));
    },
    onResolved: () => {},
  });
  return new Run({
    config,
    project,
    profile,
    slug: 'demo',
    ...(runOptions.guided ? { executionMode: 'guided' as const, guidedEngineVersion: runOptions.engineVersion ?? 4 } : {}),
    gate,
    askGate: new AskGate({ onPending: () => {}, onAnswered: () => {} }),
    emit: (e) => events.push(e),
  });
}


const write = (file_path: string, content: string): Reply => ({ tool: 'Write', args: { file_path, content } });

const INTENT_REPLIES = (): Reply[] => [
  write(
    '.sdlc/demo/intent.md',
    [
      '# Задача: demo',
      '',
      '- **Контур:** мелкий',
      '- **Ветка витка:** sdlc/demo',
      '',
      '## Приёмка',
      '',
      '| id | Пункт | Как проверить |',
      '|---|---|---|',
      '| claim-1 | версия поднята до 2 | `version === 2` |',
      '',
    ].join('\n'),
  ),
  write('.sdlc/demo/readiness.md', '# Готовность: demo\n\n- Прогон 1: готова\n'),
  { text: 'готово' },
];

const PLAN_REPLIES = (): Reply[] => [
  write(
    '.sdlc/demo/plan.md',
    [
      '# План: demo',
      '',
      '- **Одобрение:** ‹подпись и дата›',
      '',
      '## files_to_touch',
      '',
      '| Путь | Что делаем |',
      '|---|---|',
      '| src/app.js | поднять версию |',
      '',
    ].join('\n'),
  ),
  { text: 'план готов' },
];

const CHUNK_REPLIES = (): Reply[] => [
  write('src/app.js', 'export const version = 2;\n'),
  write('.sdlc/demo/chunk-1-journal.md', '# Журнал chunk 1\n\n- **Подтвердил:** ‹подпись и дата›\n\n## Что сделано\n\nверсия поднята до 2\n'),
  { text: 'правка сделана' },
];


export { makeProject, makeRun, GATES, TEMPLATES, INTENT_REPLIES, PLAN_REPLIES, CHUNK_REPLIES };
export type Reply = { text: string } | { tool: string; args: Record<string, unknown> };
