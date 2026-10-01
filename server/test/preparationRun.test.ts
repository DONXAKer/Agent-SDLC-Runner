import { ok, strictEqual, throws } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, it } from 'node:test';
import { STAGE_ORDER, emptyUsage } from '@sdlc-runner/shared';
import type { StageId } from '@sdlc-runner/shared';
import { Run } from '../src/run/Run.ts';
import { ApprovalGate } from '../src/approval/gate.ts';
import { AskGate } from '../src/approval/askGate.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { ResolvedProfile, ResolvedRoute, ProjectConfig } from '../src/config/schema.ts';
import type { StageExecutor } from '../src/exec/StageExecutor.ts';
import { readArtifact, writeArtifact } from '../src/artifacts/artifact.ts';
import { preparationSummary, preparation, preparationFingerprint, approvedPreparationProblem } from '../src/artifacts/preparation.ts';

const root = mkdtempSync(join(tmpdir(), 'sdlc-preparation-run-'));
after(() => rmSync(root, { recursive: true, force: true }));

it('новый виток: исследование → критика → подтверждение редакции → защита от поздней правки', async () => {
  const routes = Object.fromEntries(STAGE_ORDER.map((stage) => [stage, {
    stage, flow: 'loop', provider: 'stub', providerDef: { flow: 'loop', kind: 'openai-compat' },
    model: 'strong', modelId: 'strong', rank: 1, params: null, compactForms: 'off',
    formFill: false, exploreFill: false, exploreIndex: false, planAxisFill: false,
    stepFill: false, reviewFill: false, claimFill: false, leanTools: false,
  }])) as Record<StageId, ResolvedRoute>;
  const profile = { name: 'test', label: 'test', routes, ensemble: Object.fromEntries(STAGE_ORDER.map((s) => [s, [routes[s]]])) } as ResolvedProfile;
  const project: ProjectConfig = { name: 'test', projectRoot: root, activeProfile: 'test', maxBudgetUsd: 1, profiles: {} };
  const config = { runner: { operator: 'Алексей', skillsDir: join(root, 'skills'), agentsDir: join(root, 'agents'), methodologyDir: join(root, 'methodology'), limits: { maxToolResultBytes: 1000, localMaxToolResultBytes: 1000, readRangeRequiredAboveBytes: 1000, maxIterationsPerStage: 8, gateTimeoutMs: 1000, chatTimeoutMs: 1000 } }, models: { models: [] }, projects: new Map(), mcp: new Map() } as unknown as LoadedConfig;
  for (const name of ['intent', 'readiness', 'plan', 'exploration-report']) writeArtifact(join(root, 'methodology', 'templates', `${name}.template.md`), `# ${name}: ‹название витка›\n`);
  const run = new Run({ config, project, profile, slug: 'v2', gate: new ApprovalGate({ onPending: () => {}, onResolved: () => {} }), askGate: new AskGate({ onPending: () => {}, onAnswered: () => {} }), emit: () => {} });
  writeArtifact(run.paths.gates, '# Гейты\n\n## Набор\n\n| Гейт | Вкл | Где отчитывается | Чем реализован |\n|---|---|---|---|\n' + ['Сборка', 'Тесты', 'Scope: файлы вне плана', 'Анти-обход тест-гейта', 'Ревью независимым агентом'].map((name) => `| ${name} | да — минимум | этап 6 | ${name === 'Сборка' || name === 'Тесты' ? '`node --version`' : 'скрипт'} |`).join('\n'));
  writeArtifact(join(root, 'src', 'list.js'), 'export function list() { return []; }\n');
  let calls = 0;
  const executor: StageExecutor = { flow: 'loop', run: async (req) => {
    calls++;
    if (req.allowedTools.length === 0) return { ok: true, note: '', finalText: req.prompt.system.startsWith('Независимо') ? 'Неизвестная зона: пустой результат и exit 0.' : '{"issues":[]}', usage: emptyUsage() };
    if (req.prompt.system.includes('Составь черновик')) {
      writeArtifact(run.paths.intent, '# Задача\n## Коротко\nФильтр зон\n## Зачем\nПоддержке нужен один тариф\n## Что делаем\nФильтруем list\n## Чего не делаем\nНе меняем формат\n## Открытые вопросы\n- [ ] [неблокирующий] Цвет будущей иконки; отложено, CLI не использует иконки\n');
    } else if (req.prompt.system.includes('Исследуй текущий')) {
      writeArtifact(run.paths.explorationReport, '# Разведка\n## Карта кодовой базы\n| Путь | Сейчас | Изменение |\n|---|---|---|\n| src/list.js | Список | Фильтр |\n');
      writeArtifact(run.paths.intent, readArtifact(run.paths.intent).text + '\n## Что придётся тронуть\n- src/list.js — фильтр\n');
    } else {
      writeArtifact(run.paths.intent, readArtifact(run.paths.intent).text + '\n## Приёмочный лист\n| id | Пункт | Как проверить |\n|---|---|---|\n| claim-1 | Неизвестная зона даёт пустой результат | list --zone unknown: пусто и exit 0 |\n## Основания и сценарии\n| Основание | Сценарий | Контрпример | ID |\n|---|---|---|---|\n| Запрос пользователя | Неизвестная зона | Полный список вместо пустого | claim-1 |\n');
      writeArtifact(run.paths.plan, '# План\n- **Одобрение:** ‹имя и дата›\n## files_to_touch\n| Путь | Что делаем |\n|---|---|\n| src/list.js | Фильтр |\n## Изменения требований\nПервая редакция: неизвестная зона даёт пустой результат.\n');
    }
    const problem = req.finishGuard?.() ?? null;
    return { ok: problem === null, finalText: 'готово', usage: emptyUsage(), note: problem ?? '' };
  } };
  (run as unknown as { executorFor(): StageExecutor }).executorFor = () => executor;
  for (const stage of ['intent', 'explore', 'plan'] as const) {
    const result = await run.runStage(stage, stage === 'intent' ? { requirement: 'Добавь фильтр зон. Неизвестная зона — пустой результат и exit 0.' } : {});
    ok(result.ok, `${stage}: ${result.note}`);
  }
  strictEqual(calls, 5, 'три этапа и два независимых вызова');
  ok(preparationSummary(run.paths)?.readyToApprove);
  throws(() => run.recordDecision({ artifact: 'plan', label: 'Одобрение', granted: true, preparationFingerprint: 'устарел' }), /редакция проработки/);
  run.recordDecision({ artifact: 'plan', label: 'Одобрение', granted: true, preparationFingerprint: preparationFingerprint(run.paths) });
  strictEqual(approvedPreparationProblem(run.paths), null);
  strictEqual(preparation(run.paths)!.revisions.length, 1);
  writeArtifact(run.paths.intent, readArtifact(run.paths.intent).text.replace('exit 0', 'exit 1'));
  ok(run.blockers('chunk').some((reason) => reason.includes('изменились после подтверждения')));
  ok(run.blockers('verify').some((reason) => reason.includes('изменились после подтверждения')));
  // Следующий план меняет приёмку по тем же правилам; уже пригодное исследование сохраняется.
  const research = readArtifact(run.paths.explorationReport).text;
  writeArtifact(run.paths.intent, readArtifact(run.paths.intent).text.split('## Приёмочный лист')[0]!);
  const replanned = await run.runStage('plan');
  ok(replanned.ok, replanned.note);
  run.recordDecision({ artifact: 'plan', label: 'Одобрение', granted: true, preparationFingerprint: preparationFingerprint(run.paths) });
  strictEqual(preparation(run.paths)!.revisions.length, 2);
  strictEqual(readArtifact(run.paths.explorationReport).text, research);
  strictEqual(approvedPreparationProblem(run.paths), null);
});
