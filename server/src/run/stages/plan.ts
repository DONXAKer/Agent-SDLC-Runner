/** Этап 4 — план витка: определение этапа и проверка `files_to_touch`. */

import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  isPreparationV2,
  preparation,
  requirementProblem,
  preparationReviewProblem,
  preparationPlanEvidenceProblem,
  sourceHash,
  section,
  syncCanonicalPreparation,
} from '../../artifacts/preparation.ts';
import { reviewPreparation } from '../preparationReview.ts';
import { readGuided } from '../guidedState.ts';

import type { NormalizedCall } from '@sdlc-runner/shared';

import { DECISION, artifactExists, hasNamedInvariants, readArtifact, readDecision, writeArtifact } from '../../artifacts/artifact.ts';
import { SDLC_DIR } from '../../artifacts/paths.ts';
import { planAxisProblems, unansweredAxes } from '../../artifacts/planAxes.ts';
import {
  addedBeyondPlanPaths,
  appendFilesToTouch,
  excludedFromPlanPaths,
  extractFilesToTouch,
  forbiddenCodePaths,
  filesToTouchDirectories,
  seedFilesToTouch,
  removeFilesFromTouch,
  touchListEntries,
} from '../../artifacts/planFiles.ts';
import { appendMissingPlanStepCards, explicitStepProblems, extractExplicitSteps, planSteps } from '../../artifacts/planSteps.ts';
import { addRequirementsHash, readRequirementsHash, resolvedRequirementsHash } from '../../artifacts/resolvedRequirements.ts';
import { clarificationResolutionBlock, clarificationResolutionProblem } from '../../artifacts/clarificationResolution.ts';
import { claimIdOf } from '../../artifacts/claims.ts';
import { applyAxisAnswers } from '../../artifacts/renderAxes.ts';
import type { ResolvedRoute } from '../../config/schema.ts';
import { gateKey } from '../../gates/gatesFile.ts';
import { readTree } from '../../explore/tree.ts';
import { callersOf } from '../../explore/symbols.ts';
import { capBytes } from '../../prompt/bytes.ts';
import type { GatesFile } from '../../gates/gatesFile.ts';
import { h2SectionRanges, parseTables } from '../../md/table.ts';
import { ProviderEnvError } from '../../provider/ChatProvider.ts';
import { createProvider } from '../../provider/registry.ts';
import { acceptanceChecksFromIntent, autofillPlan, autofillReadiness } from '../formAutofill.ts';
import { hasRuntimeReadiness, readinessRun2 } from '../readinessChecks.ts';
import { fillPlanAxes } from '../planAxisFill.ts';
import { fillPlanAxesStepwise } from '../planAxisStepwise.ts';
import { explorationPathsExist } from './explore.ts';
import { claimsMinimum, hasOpenQuestions, intentFilled, intentSectionsIntact, isSmallContour, relOf } from './preconditions.ts';
import { ensureIntentSnapshot } from './intent.ts';
import type { StageContext, StageDef, StageHost, StageModule } from './types.ts';

/**
 * `files_to_touch` плана пуст — та же находка, что уже ловит `Run.blockers()` на входе в
 * `chunk` (`PlanScope выключился бы молча`), но здесь она приходит модели в её собственном
 * ходу на этапе `plan`, а не после ухода планировщика: без этой проверки виток тратил целый
 * холостой цикл — план закрывался зелёным, а бесполезность вскрывалась только на входе в
 * `chunk` (живой замер `gemma-4-e4b`/`security-bait`, 2026-09-13). Пустой список никогда не
 * легитимен в текущей архитектуре: `chunk.skipIf` отсутствует, `planScope.ts` трактует
 * пустой `files_to_touch` как «защита выключена», а не как «нечего трогать».
 *
 * Переиспользует `extractFilesToTouch` — тот же разбор секции, что и `Run.planFilesFor`
 * (второй парсер здесь завёл бы риск расхождения, см. предупреждение в `planFiles.ts`).
 */
export function filesToTouchProblem(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null; // отсутствие плана ловит соседнее предусловие
  const directories = filesToTouchDirectories(plan.text);
  if (directories.length > 0) {
    return `files_to_touch перечисляет каталоги вместо файлов: ${[...new Set(directories)].join(', ')}; укажи конкретный файл, который будет создан`;
  }
  if (extractFilesToTouch(plan.text).length > 0) return null;
  if (readGuided(c.paths) && plan.text.includes('<!-- guided:no-change -->')) return null;
  return (
    `в files_to_touch плана нет ни одного пути: без него PlanScope выключится молча на ` +
    `этапе 5, и запись перестанет быть ограниченной планом. Впиши хотя бы один путь строкой ` +
    `таблицы.`
  );
}

/** Paths stated as implementation targets in Intent must survive into the executable plan. */
export function extractIntentImplementationPaths(intentText: string): string[] {
  const implementation = section(intentText, 'Что делаем');
  // Intent often names read-only evidence in phrases such as "на основе анализа
  // src/foo.ts". Require paths attached to implementation verbs, not every
  // path mentioned in the prose; the approved plan still guards actual writes.
  const required = [...implementation.matchAll(/(?:реализ\w*|реализац\w*|созда\w*|добав\w*|измен\w*|экспорт\w*|обнов\w*)[^\n.;]{0,180}?((?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,12})/giu)]
    .map((match) => (match[1] ?? '').replace(/\\/gu, '/'));
  return [...new Set(required.filter((path) =>
    path !== '' && !path.startsWith('/') && !/^[a-z]:/iu.test(path) && !path.split('/').includes('..'),
  ))];
}

/** Explicit public-export paths in the original request are implementation targets too. */
export function extractExplicitExportPaths(requests: readonly string[]): string[] {
  const paths = requests.flatMap((request) =>
    [...request.matchAll(/(?:export(?:ed)?|экспорт\p{L}*)[^\n.;]{0,180}?((?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,12})/giu)]
      .map((match) => (match[1] ?? '').replace(/\\/gu, '/')),
  );
  return [...new Set(paths.filter((path) =>
    path !== '' && !path.startsWith('/') && !/^[a-z]:/iu.test(path) && !path.split('/').includes('..'),
  ))];
}

export function intentNewTestPath(intentText: string, projectRoot: string, originalRequests: readonly string[] = [], planText = ''): string | null {
  const requestText = originalRequests.join('\n');
  const existingTestsForbidden = /(?:не\s+(?:меня\p{L}*|изменя\p{L}*|модифицир\p{L}*|трога\p{L}*).{0,60}(?:существующ\p{L}*.{0,20})?(?:тест|test\/)|(?:существующ\p{L}*.{0,20})?(?:тест\p{L}*|test\/)\s+не\s+(?:меня\p{L}*|изменя\p{L}*|трога\p{L}*))/iu
    .test(section(intentText, 'Чего не делаем') + '\n' + requestText) ||
    /существующ\p{L}*\s+тест\p{L}*[^\n.]{0,80}без\s+(?:правки|изменений)/iu
      .test((section(intentText, 'Чего не делаем') + '\n' + requestText).replace(/[*`_]/gu, ''));
  const requiresNewTestFile =
    /нов\p{L}*\s+тест\p{L}*.{0,80}(?:отдельн\p{L}*\s+)?файл|тест\p{L}*.{0,80}(?:отдельн\p{L}*\s+)?нов\p{L}*\s+файл|(?:отдельн\p{L}*\s+)?нов\p{L}*\s+файл.{0,80}тест/iu.test(intentText + '\n' + requestText) ||
    // If Intent forbids editing existing tests but names a test path or requires test
    // coverage, planning against an existing file would make the task impossible.
    (existingTestsForbidden && /(?:test\/|тест\p{L}*)/iu.test(intentText + '\n' + requestText));
  if (!requiresNewTestFile) return null;
  const testName = /(?:\.test\.[a-z0-9]+|_test\.go|(?:^|\/)test_[^/]+\.py)$/iu;
  const safeNewTest = (path: string): boolean => testName.test(path) && !path.startsWith('/') &&
    !/^[a-z]:/iu.test(path) && !path.split('/').includes('..') && !existsSync(join(projectRoot, path));
  // A literal filename requested by the user takes precedence over project conventions.
  const explicit = [...requestText.matchAll(/(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]+/giu)]
    .map(match => match[0]).find(safeNewTest);
  if (explicit !== undefined) return explicit;
  const intentTest = extractIntentImplementationPaths(intentText).find(safeNewTest);
  if (intentTest !== undefined) return intentTest;
  const examples = readTree(projectRoot).files.filter((file) => file.kind === 'test').map((file) => file.path.replace(/\\/gu, '/'));
  const planned = extractFilesToTouch(planText).map(path => path.replace(/\\/gu, '/')).find(path => safeNewTest(path) &&
    examples.some(example => example.slice(0, example.lastIndexOf('/') + 1) === path.slice(0, path.lastIndexOf('/') + 1)));
  if (planned !== undefined) return planned;
  const implementation = section(intentText, 'Что делаем');
  const functionName = /(?:функц(?:ия|ию|ии|ией|иею)|function)\s+[`']?([A-Za-z_$][\w$]*)/iu;
  // Prefer the positive implementation scope. Excluded functions are not test targets.
  const symbol = functionName.exec(implementation)?.[1] ??
    functionName.exec(requestText)?.[1] ??
    functionName.exec(section(intentText, 'Приёмочный лист'))?.[1];
  if (symbol === undefined) return null;
  // Infer the new test target from this project's existing test naming pattern.
  // If the repository offers no recognizable convention, let the plan author
  // choose a path instead of assuming TypeScript, a `test/` directory, or a suffix.
  const conventions: { directory: string; makeName: (index: number) => string; extension: string }[] = [];
  for (const example of examples) {
    const slash = example.lastIndexOf('/');
    const directory = slash < 0 ? '' : example.slice(0, slash + 1);
    const basename = example.slice(slash + 1);
    const jestStyle = /^.+\.test\.(.+)$/iu.exec(basename);
    if (jestStyle !== null) {
      const extension = jestStyle[1]!;
      conventions.push({ directory, extension, makeName: (index) => `${symbol}${index === 0 ? '' : `.${index}`}.test.${extension}` });
      continue;
    }
    const goStyle = /^.+_test\.go$/iu.test(basename);
    if (goStyle) {
      conventions.push({ directory, extension: 'go', makeName: (index) => `${symbol}${index === 0 ? '' : `_${index}`}_test.go` });
      continue;
    }
    if (/^test_.+\.py$/iu.test(basename)) {
      conventions.push({ directory, extension: 'py', makeName: (index) => `test_${symbol.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)}${index === 0 ? '' : `_${index}`}.py` });
    }
  }
  const unique = new Map(conventions.map((convention) => [`${convention.directory}:${convention.extension}`, convention]));
  for (const convention of unique.values()) {
    for (let index = 0; index < 10; index++) {
      const candidate = `${convention.directory}${convention.makeName(index)}`;
      if (!existsSync(join(projectRoot, candidate))) return candidate;
    }
  }
  return null;
}

export function intentImplementationPathsProblem(
  intentText: string,
  planText: string,
  additionalRequiredPaths: readonly string[] = [],
): string | null {
  const required = [...new Set([...extractIntentImplementationPaths(intentText), ...additionalRequiredPaths])];
  const planned = new Set(extractFilesToTouch(planText).map((path) => path.replace(/\\/gu, '/')));
  const missing = required.filter((path) => !planned.has(path));
  return missing.length === 0
    ? null
    : `в «Что делаем» названы файлы реализации, отсутствующие в files_to_touch: ${missing.join(', ')}; добавь шаг на каждый такой файл`;
}

/** Reject explicit no-touch boundaries and cards whose action is aimed at another Intent target. */
export function intentPlanBoundaryProblem(intentText: string, planText: string, projectRoot?: string): string | null {
  const excluded = section(intentText, 'Чего не делаем');
  const forbidden = new Set(forbiddenCodePaths(excluded));
  const touched = extractFilesToTouch(planText);
  const forbiddenTouched = touched.filter((path) => forbidden.has(path));
  if (forbiddenTouched.length > 0) {
    return `files_to_touch нарушает явную границу «Чего не делаем»: ${forbiddenTouched.join(', ')}; удали эти пути и их карточки.`;
  }
  const existingTestsForbidden = /(?:не\s+делаем|не\s+(?:меня\p{L}*|изменя\p{L}*|трога\p{L}*)).{0,80}(?:существующ\p{L}*.{0,20})?(?:тест\p{L}*|test\/)|(?:существующ\p{L}*.{0,20})?(?:тест\p{L}*|test\/)\s+не\s+(?:меня\p{L}*|изменя\p{L}*|трога\p{L}*)/iu
    .test(section(intentText, 'Чего не делаем'));
  if (existingTestsForbidden && projectRoot !== undefined) {
    const editedExistingTests = touched.filter((path) => /^test\//iu.test(path) && existsSync(join(projectRoot, path)));
    if (editedExistingTests.length > 0) {
      return `files_to_touch включает существующие тесты, которые Intent запрещает менять: ${editedExistingTests.join(', ')}; оставь только новый файл тестов.`;
    }
  }

  const targets = extractIntentImplementationPaths(intentText);
  const steps = extractExplicitSteps(planText);
  for (const target of targets) {
    if (target.startsWith('test/')) continue; // a test legitimately references the source it exercises
    const step = steps.find((candidate) => candidate.file.replace(/\\/gu, '/') === target);
    if (step === undefined) continue;
    const action = `${step.title} ${step.action}`.replace(/\\/gu, '/').toLowerCase();
    const otherTarget = targets.find((path) => path !== target && action.includes(path.toLowerCase()));
    if (otherTarget !== undefined && !/(?:экспорт\p{L}*|export)/iu.test(action)) {
      return `шаг ${step.n} адресован ${target}, но его действие описывает ${otherTarget}; перепиши действие для файла карточки.`;
    }
  }
  return null;
}

/** Prepare mandatory Intent targets and editable per-file cards before the plan model starts. */
export function preparePlanImplementationCards(
  planText: string,
  intentText: string,
  projectRoot: string,
  additionalRequiredPaths: readonly string[] = [],
  originalRequests: readonly string[] = [],
): { text: string; paths: string[] } {
  const implementation = `${section(intentText, 'Что делаем')}\n${originalRequests.join('\n')}`;
  const paths = extractIntentImplementationPaths(intentText);
  const symbol = /(?:функц(?:ия|ию|ии)?|function)\s+([A-Za-z_$][\w$]*)/iu.exec(implementation)?.[1];
  const checks = acceptanceChecksFromIntent(intentText);
  const testPath = intentNewTestPath(intentText, projectRoot, originalRequests, planText);
  const testCandidates = testPath === null ? [] : [testPath];
  const mandatory = [...new Set([...paths, ...additionalRequiredPaths, ...(testPath === null ? [] : [testPath])])];
  const planned = new Set(extractFilesToTouch(planText).map((path) => path.replace(/\\/gu, '/')));
  const missing = mandatory.filter((path) => !planned.has(path));
  const entries = missing.map((path) => ({
    path,
    note: testCandidates.includes(path)
      ? 'новый файл для поведенческих тестов из acceptance листа'
      : `${existsSync(join(projectRoot, path)) ? 'существующий' : 'новый'} файл из «Что делаем»; опиши конкретное изменение`,
  }));
  const added = appendFilesToTouch(planText, entries);
  let text = added.text;
  const fileSlot = /^(-\s*файл:\s*)‹существующий путь›\s*\(существующий\)/m;
  const testFileSlot = /^(-\s*файл:\s*)‹новый путь теста›\s*\(новый\)/m;
  const firstTarget = paths[0];
  if (firstTarget !== undefined && fileSlot.test(text)) {
    const state = existsSync(join(projectRoot, firstTarget)) ? 'существующий' : 'новый';
    text = text.replace(fileSlot, `$1${firstTarget} (${state})`);
  }
  if (testPath !== null && testFileSlot.test(text)) {
    text = text.replace(testFileSlot, `$1${testPath} (новый)`);
  }
  const cards = appendMissingPlanStepCards(text);
  text = cards.text;

  // Carry acceptance checks into the test-file step so they stay attached to
  // the implementation target chosen by the requirements.
  const testableChecks = checks.filter((check) =>
    !/выбор.{0,35}(?:метод|способ)|зафиксир.{0,30}план/iu.test(`${check.behavior} ${check.procedure}`),
  );
  if (testableChecks.length > 0) {
    const testStep = testPath === null ? undefined : extractExplicitSteps(text).find((step) => step.file === testPath);
    const testTitle = testStep === undefined ? null : `### Шаг ${testStep.n} — ${testStep.title}`;
    const testStart = testTitle === null ? -1 : text.indexOf(testTitle);
    if (testStart >= 0) {
      const nextHeading = /^###\s+Шаг\s+\d+\b/gmu;
      nextHeading.lastIndex = testStart + (testTitle?.length ?? 0);
      const next = nextHeading.exec(text)?.index ?? text.indexOf('\n## ', testStart);
      const end = next < 0 ? text.length : next;
      let card = text.slice(testStart, end);
      const claimIds = testableChecks.map(check => check.id).join(', ');
      card = card.replace(/^(-\s*действие:\s*)(.*)$/mu, (line, prefix: string, value: string) =>
        !value.trim() || /[‹›]/u.test(value) || /^Добавить поведенческие тесты:/u.test(value) || /^(?:добавить|создать|написать)\s+тесты[.!]?$/iu.test(value.trim())
          ? `${prefix}Добавить поведенческие тесты для ${claimIds}; использовать полные процедуры и ожидаемые результаты из приёмочного листа.`
          : line);
      card = card.replace(/^(-\s*закрывает:\s*).*$/mu, `$1${testableChecks.map((check) => check.id).join(', ')}`);
      card = card.replace(/^(-\s*проверка:\s*)(.*)$/mu, (line, prefix: string, value: string) =>
        !value.trim() || /[‹›]/u.test(value)
          ? `${prefix}Прогнать тестовую команду проекта и все сценарии ${claimIds} из приёмочного листа · ожидаемо: все сценарии ${claimIds} проходят; существующие тесты остаются зелёными.`
          : line);
      card = card.replace(/^(-\s*контракт:\s*)(.*)$/mu, (line, prefix: string, value: string) =>
        !value.trim() || /[‹›]/u.test(value)
          ? `${prefix}н/п — тестовый файл проверяет согласованные требования и не меняет публичный интерфейс.`
          : line);
      text = text.slice(0, testStart) + card + text.slice(end);
    }
  }

  // A public-export path is mechanically determined by Intent: give the model a
  // concrete draft card instead of asking a small model to invent another nested form.
  if (symbol !== undefined) {
    for (const path of cards.paths) {
      const pathAt = implementation.indexOf(path);
      const exportTarget = pathAt >= 0 && /экспорт\p{L}*|export/iu.test(implementation.slice(Math.max(0, pathAt - 100), pathAt));
      if (!exportTarget) continue;
      const source = paths.find((candidate) => candidate !== path && implementation.indexOf(candidate) < pathAt);
      const related = checks.filter((check) =>
        `${check.behavior} ${check.procedure} ${check.expected}`.toLowerCase().includes(path.toLowerCase()),
      );
      const claimIds = related.map((check) => check.id);
      if (claimIds.length === 0) continue;
      const steps = extractExplicitSteps(text);
      const dependency = source === undefined ? null : steps.find((step) => step.file === source)?.n ?? null;
      const checkText = related.map((check) => `${check.procedure} · ожидаемо: ${check.expected}`).join('; ');
      const action = `Экспортировать ${symbol} из ${source ?? 'модуля реализации'} через публичный вход ${path}; сохранить существующие экспорты.`;
      const contract = `Добавить публичный экспорт ${symbol} из ${source ?? 'модуля реализации'} в ${path}; прежние экспорты остаются доступны.`;
      const titleAt = text.indexOf(`— Изменить ${path}`);
      if (titleAt < 0) continue;
      const blockStart = text.lastIndexOf('### Шаг ', titleAt);
      const nextHeading = /^###\s+Шаг\s+\d+\b/gmu;
      nextHeading.lastIndex = titleAt;
      const blockEnd = nextHeading.exec(text)?.index ?? text.indexOf('\n## ', titleAt);
      const end = blockEnd < 0 ? text.length : blockEnd;
      let card = text.slice(blockStart, end);
      const replaceField = (field: string, value: string): void => {
        card = card.replace(new RegExp(`^(-\\s*${field}:\\s*).*$`, 'mu'), `$1${value}`);
      };
      replaceField('символ', `новый: ${symbol}`);
      replaceField('действие', action);
      replaceField('закрывает', claimIds.join(', '));
      replaceField('проверка', checkText);
      replaceField('контракт', contract);
      replaceField('зависит от', dependency === null ? 'нет' : `шаг ${dependency}`);
      text = text.slice(0, blockStart) + card + text.slice(end);
    }
  }
  return { text, paths: missing };
}

/** Reapply a task-mandated new test-file target if the model replaces it with an existing test. */
export function enforceIntentTestFileTarget(
  planText: string,
  intentText: string,
  projectRoot: string,
  originalRequests: readonly string[] = [],
): { text: string; path: string | null; changed: boolean } {
  const testPath = intentNewTestPath(intentText, projectRoot, originalRequests, planText);
  if (testPath === null) return { text: planText, path: null, changed: false };
  let text = planText;
  const boundaries = section(intentText, 'Чего не делаем');
  const existingTestsForbidden = /существующ\p{L}*.{0,50}(?:тест|test\/)|не\s+(?:меня\p{L}*|изменя\p{L}*|модифицир\p{L}*|трога\p{L}*).{0,60}(?:тест|test\/)/iu.test(boundaries);
  if (existingTestsForbidden) {
    const conflicting = extractFilesToTouch(text).filter((path) =>
      path.startsWith('test/') && path !== testPath && existsSync(join(projectRoot, path)),
    );
    const directories = filesToTouchDirectories(text).filter((path) => path.startsWith('test/'));
    const removed = removeFilesFromTouch(text, [...conflicting, ...directories]);
    text = removed.text;
    // A conflicting existing test may also have survived as a separate scaffolded
    // card. Remove only cards for those forbidden files; retain the new test card.
    const forbidden = new Set(conflicting.map((path) => path.toLowerCase()));
    const heading = /^###\s*Шаг\s+\d+\b[^\r\n]*\r?\n/gmu;
    const matches = [...text.matchAll(heading)];
    const blocks = matches.map((match, index) => {
      const start = match.index!;
      const end = matches[index + 1]?.index ?? text.length;
      const content = text.slice(start, end);
      const file = /^-\s*файл:\s*([^\s(]+)/mu.exec(content)?.[1]?.replace(/[`;,]+$/gu, '').toLowerCase();
      const testLike = /(?:тест|провер|test)/iu.test(`${match[0]}\n${content}`);
      return { start, end, content, file, preserve: file !== undefined && forbidden.has(file) && testLike };
    });
    let rebuilt = '';
    let cursor = 0;
    for (const block of blocks) {
      rebuilt += text.slice(cursor, block.start);
      if (block.file === undefined || !forbidden.has(block.file) || block.preserve) {
        rebuilt += block.preserve
          ? block.content.replace(/(^-\s*файл:\s*)[^\r\n]*/mu, `$1${testPath} (новый)`)
          : block.content;
      }
      cursor = block.end;
    }
    text = rebuilt + text.slice(cursor);
  }
  if (!extractFilesToTouch(text).includes(testPath)) {
    text = appendFilesToTouch(text, [{ path: testPath, note: 'новый файл тестов, как требует задача' }]).text;
  }
  return { text, path: testPath, changed: text !== planText };
}

/**
 * `files_to_touch` плана против «Что придётся тронуть» разведки (4.1): каждое расхождение
 * обязано быть объяснено строкой плана, а не молча — план вправе сузить или расширить
 * список (шаблон говорит это прямо), но не вправе разойтись с разведкой БЕЗ причины.
 *
 * Пустой список разведки не проверяется (мелкий контур, разведки не было — сверять не с
 * чем, это законно). Путь разведки, отсутствующий в `files_to_touch`, обязан быть назван в
 * «Из задачи исключено»; путь `files_to_touch`, которого нет в разведке, — в «Добавлено
 * сверх разведки». Оба скана — общим `planFiles.ts::pathsAfterLabel`, второй копии не
 * заводится.
 */
export function planTouchDiscrepancyProblem(c: StageContext): string | null {
  const intent = readArtifact(c.paths.intent);
  if (!intent.exists) return null; // отсутствие задачи ловит соседнее предусловие
  const touch = touchListEntries(intent.text).map((e) => e.path);
  if (touch.length === 0) return null;

  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null; // отсутствие плана ловит соседнее предусловие
  const files = extractFilesToTouch(plan.text);
  const excluded = excludedFromPlanPaths(plan.text);
  const added = addedBeyondPlanPaths(plan.text);

  const droppedSilently = touch.filter((p) => !files.includes(p) && !excluded.includes(p));
  const addedSilently = files.filter((p) => !touch.includes(p) && !added.includes(p));
  if (droppedSilently.length === 0 && addedSilently.length === 0) return null;

  const parts: string[] = [];
  if (droppedSilently.length > 0) {
    parts.push(
      `в files_to_touch нет и в «Из задачи исключено» не названы: ${droppedSilently.join(', ')}`,
    );
  }
  if (addedSilently.length > 0) {
    parts.push(
      `в files_to_touch есть, а в «Что придётся тронуть» и в «Добавлено сверх разведки» — нет: ` +
        addedSilently.join(', '),
    );
  }
  return `files_to_touch разошёлся с «Что придётся тронуть» разведки без объяснения — ${parts.join('; ')}.`;
}

/**
 * Явная форма шага (`### Шаг N`, `artifacts/planSteps.ts::extractExplicitSteps`) — со
 * строкой-образцом из шаблона (`templates/plan.template.md`), не заполненная по существу.
 *
 * Найдено серией local6 (2026-09-24): модель дважды меняла заголовок шага и поле
 * «действие», но оставляла `файл: src/tariffs.ts`, `символ: priceFor`, `закрывает:
 * claim-2, claim-4`, `проверка: node --test test/oversize.test.ts` — дословно текстом
 * образца. `src/tariffs.ts` не входил ни в `files_to_touch`, ни в проект, и явно не был
 * помечен новым — а не будь этой проверки, chunk потом читал `test/oversize.test.ts`
 * как реальный файл (`Read` на несуществующий путь, потерянные ходы).
 *
 * Проверяется только `файл`, не `проверка`: у `проверка` legит-форма почти всегда
 * называет ЕЩЁ НЕ СУЩЕСТВУЮЩИЙ тестовый файл (создаётся тем же шагом на chunk'е) —
 * проверка по этому полю дала бы находку на каждом нормальном плане. `файл` — путь,
 * который шаг РЕДАКТИРУЕТ, и он обязан быть либо уже объявлен (`files_to_touch`), либо
 * явно помечен новым, либо реально существовать; если ни то, ни другое, ни третье —
 * это чужой путь, дошедший из необновлённого образца.
 */
export function planStepSampleTextProblem(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null;
  const steps = extractExplicitSteps(plan.text);
  if (steps.length === 0) return null;
  const files = extractFilesToTouch(plan.text);
  for (const step of steps) {
    if (step.isNew && existsSync(join(c.paths.projectRoot, step.file))) {
      return (
        `явная форма шага ${step.n} помечает существующий файл «${step.file}» как новый. ` +
        'Укажи, что файл существующий, либо выбери новый путь, как требует задача.'
      );
    }
    if (files.includes(step.file) || step.isNew) continue;
    if (existsSync(join(c.paths.projectRoot, step.file))) continue;
    return (
      `явная форма шага ${step.n} называет файл «${step.file}» — его нет ни в files_to_touch, ` +
      `ни на диске, и он не помечен новым. Похоже на нетронутую строку-образец шаблона плана ` +
      `(файл/символ/проверка скопированы из примера явной формы) — впиши настоящий путь этого ` +
      `шага или подтверди в files_to_touch.`
    );
  }
  return null;
}

/** Структура шагов и адресуемость claims проверяются до завершения plan. */
export function planStepsProblem(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null;
  // Existing plans in the legacy files_to_touch form stay on the locator fallback.
  if (extractExplicitSteps(plan.text).length === 0) return null;
  const problems = explicitStepProblems(plan.text);
  if (isPreparationV2(c.paths)) {
    const intent = readArtifact(c.paths.intent);
    const claims = parseTables(section(intent.text, 'Приёмочный лист'))
      .flatMap((table) => table.rows)
      .map((row) => claimIdOf(`| ${row.join(' | ')} |`))
      .filter((id): id is string => id !== null);
    const known = new Set(claims);
    const steps = extractExplicitSteps(plan.text);
    const referenced = steps.flatMap((step) => step.claims);
    const missing = claims.filter((id) => !referenced.includes(id));
    const unknown = referenced.filter((id) => !known.has(id));
    if (missing.length > 0) problems.push(`ни один шаг не покрывает требования ${missing.join(', ')}`);
    if (unknown.length > 0) problems.push(`шаги ссылаются на отсутствующие требования ${[...new Set(unknown)].join(', ')}`);
  }
  if (problems.length === 0) return null;
  return `карточки шагов плана не готовы:\n${problems.map((p) => `- ${p}`).join('\n')}`;
}

/**
 * Сверяет адреса явного плана с текущим деревом до начала chunk. Это ранняя защита от
 * устаревшей карты; старые планы остаются на прежнем locator-пути и не блокируются.
 */
export function planMapProblem(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null;
  const requirementProblem = planRequirementsProblem(c);
  if (requirementProblem !== null) return requirementProblem;
  const clarificationProblem = planClarificationProblem(c, plan.text);
  if (clarificationProblem !== null) return clarificationProblem;
  const steps = extractExplicitSteps(plan.text);
  if (steps.length === 0) return null;
  const files = new Set(extractFilesToTouch(plan.text));
  const intentText = readArtifact(c.paths.intent).text;
  const originalRequests = preparation(c.paths)?.requests ?? [];
  const index = readTree(c.paths.projectRoot);
  const issues: string[] = [];
  for (const step of steps) {
    if (!files.has(step.file)) {
      issues.push(`шаг ${step.n}: ${step.file} отсутствует в files_to_touch`);
      continue;
    }
    if (step.isNew) continue;
    const indexed = index.files.find((f) => f.path === step.file);
    if (indexed === undefined) {
      if (!existsSync(join(c.paths.projectRoot, step.file))) {
        issues.push(`шаг ${step.n}: существующий файл ${step.file} не найден`);
      }
      continue; // неиндексируемые форматы не дают надёжной проверки символов
    }
    if (step.symbol !== null && !indexed.symbols.some((symbol) => symbol.name === step.symbol)) {
      const namedByTask = originalRequests.some((request) => request.includes(step.symbol!));
      const requiredInIntent = intentText.includes(step.symbol);
      if (!(requiredInIntent && (step.isNewSymbol || namedByTask))) {
        issues.push(`шаг ${step.n}: символ ${step.symbol} не найден в ${step.file} и не подтверждён как новый требуемый символ`);
      }
    }
  }
  const callersProblem = planCallersProblem(c, plan.text, index);
  if (callersProblem !== null) issues.push(callersProblem);
  return issues.length === 0
    ? null
    : `карта плана разошлась с кодовой базой; вернись на этап 4 до расхода попытки:\n${issues.map((p) => `- ${p}`).join('\n')}`;
}

/** Every recorded human answer must be explicitly reconciled in the approved plan. */
export function planClarificationProblem(c: StageContext, planText?: string): string | null {
  const plan = planText ?? readArtifact(c.paths.plan).text;
  const report = readArtifact(c.paths.clarificationReport);
  const intent = readArtifact(c.paths.intent);
  const acceptedClaimIds = new Set(
    (intent.exists ? intent.text : '').split(/\r?\n/)
      .map(claimIdOf)
      .filter((claimId): claimId is string => claimId !== null),
  );
  return clarificationResolutionProblem(plan, report.exists ? report.text : '', acceptedClaimIds, isPreparationV2(c.paths));
}

/** Require a per-callsite disposition for every indexed caller of a changed contract. */
export function planCallersProblem(
  c: StageContext,
  planText?: string,
  indexOverride?: ReturnType<typeof readTree>,
): string | null {
  const plan = planText ?? readArtifact(c.paths.plan).text;
  const steps = extractExplicitSteps(plan).filter(
    // Без `\b`: граница слова не работает рядом с кириллической «п», и фильтр «н/п»
    // молча не срабатывал (тот же класс бага, что в explore/symbols.ts).
    (step) => step.contractChange !== null && !/^н\s*\/\s*п/i.test(step.contractChange),
  );
  if (steps.length === 0) return null;
  const index = indexOverride ?? readTree(c.paths.projectRoot);
  const sectionStart = plan.search(/^##\s+Затронутые вызовы\/сигнатуры\s*$/im);
  const section = sectionStart < 0 ? '' : (plan.slice(sectionStart).split(/^##\s+/m).slice(1)[0] ?? '');
  const rows = section.split(/\r?\n/).filter((line) => /^\s*\|/.test(line)).map((line) =>
    line.split('|').slice(1, -1).map((cell) => cell.replace(/`/g, '').trim()),
  );
  const filesToTouch = new Set(extractFilesToTouch(plan));
  const missing: string[] = [];
  for (const step of steps) {
    if (step.isNew) continue;
    if (step.symbol === null) {
      missing.push(`шаг ${step.n}: меняющийся контракт не привязан к символу`);
      continue;
    }
    const file = index.files.find((candidate) => candidate.path === step.file);
    if (file === undefined || !file.symbols.some((symbol) => symbol.name === step.symbol && symbol.exported)) continue;
    const callers = callersOf(index, step.symbol, step.file, index.files.length);
    const matchingRows = rows.filter((row) => row[0] === `${step.file}:${step.symbol}`);
    for (const caller of callers) {
      const address = `${caller.path}:${caller.line}`;
      const addressed = matchingRows.some((row) =>
        (row[2] ?? '').split(/[;,]/).some((part) => part.trim().replace(/\s+\([^)]*\)$/, '') === address) &&
        (filesToTouch.has(caller.path)
          ? /^да(?:\s|$)/i.test(row[3] ?? '')
          : /^нет\s*[—-]\s*\S/i.test(row[3] ?? '')),
      );
      if (!addressed) missing.push(`${step.file}:${step.symbol} ← ${address}`);
    }
  }
  if (missing.length === 0) return null;
  const bounded = missing.slice(0, 30);
  return `карта вызывающих не доведена: для каждого найденного места вызова укажи контракт и решение по колонке «Учтены в files_to_touch?»: ${bounded.join('; ')}${missing.length > bounded.length ? `; ещё ${missing.length - bounded.length}` : ''}`;
}

/** Require the approved plan to identify the exact requirement sources it was based on. */
export function planRequirementsProblem(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null;
  const intent = readArtifact(c.paths.intent);
  const clarification = readArtifact(c.paths.clarificationReport);
  const expected = resolvedRequirementsHash(intent.exists ? intent.text : '', clarification.exists ? clarification.text : '');
  const actual = readRequirementsHash(plan.text);
  return actual === expected
    ? null
    : `источники требований изменились после подготовки плана или в плане нет их отпечатка (ожидался SHA-256 ${expected}); вернись на этап 4 и получи новое одобрение`;
}

/** Готовая карта вызывающих для файлов, уже предложенных в `files_to_touch`. */
export function callersBlock(c: StageContext): string | null {
  const plan = readArtifact(c.paths.plan);
  if (!plan.exists) return null;
  const paths = extractFilesToTouch(plan.text);
  if (paths.length === 0) return null;
  const index = readTree(c.paths.projectRoot);
  const indexedPaths = new Set(paths);
  const rows: string[] = [];
  for (const file of index.files) {
    if (!indexedPaths.has(file.path) || file.kind === 'doc') continue;
    for (const symbol of file.symbols.filter((s) => s.exported)) {
      const callers = callersOf(index, symbol.name, file.path, index.files.length);
      if (callers.length === 0) continue;
      rows.push(
        `| \`${file.path}:${symbol.name}\` | ${callers.map((v) => `\`${v.path}:${v.line}${v.symbol === null ? '' : ` (${v.symbol})`}\``).join(', ')} |`,
      );
    }
  }
  if (rows.length === 0) {
    return [
      '## Вызывающие из индекса проекта',
      '',
      'Для экспортируемых символов в текущей карте вызывающие не найдены. Индекс ограничен распознанными исходниками; проверьте публичные потребители вне репозитория отдельно.',
    ].join('\n');
  }
  const text = [
    '## Вызывающие из индекса проекта',
    '',
    'Факты индекса для файлов files_to_touch. Это кандидаты; решение об изменении контракта и необходимости править вызовы остаётся в плане.',
    '',
    '| Символ | Вызывающие (все найденные места) |',
    '|---|---|',
    ...rows,
    ...(index.skipped.files > 0 ? ['', `Индекс пропустил файлов: ${index.skipped.files}; карта неполна.`] : []),
  ].join('\n');
  return capBytes(text, 24_000).text;
}

/**
 * Строка набора для гейта «Разбор последствий», если он включён и отчитывается на этапе 4.
 *
 * Одно место на оба потребителя (страж этапа 4 и перенос статуса в отчёт приёмки).
 * Пока условие было выписано дважды, статус гейта решался в двух местах и в два разных
 * момента — ровно то, от чего сторожит «единственная точка решения» (ревью).
 *
 * Этап строки уважается наравне с включённостью: гейт, перенесённый проектом на другой
 * этап, отчитывается там, и требовать секцию на четвёртом значило бы держать проверку,
 * о которой набор не просил.
 */
export function axesGateRow(gates: GatesFile | null): { name: string } | null {
  if (gates === null) return null;
  const row = gates.rows.find(
    (r) => gateKey(r.name) === gateKey('Разбор последствий') && r.enabled,
  );
  if (row === undefined || row.reportsAt !== 'этап 4') return null;
  return row;
}

/**
 * Проблемы разбора последствий (гейт «Разбор последствий», этап 4).
 *
 * Гейт выключен — проверять нечего: строка набора и есть решение проекта о том, ведётся
 * ли разбор. Пустой массив у включённого гейта означает «разбор доведён», а не «оси не
 * затронуты»: второе записывается исходом «н/п» с причиной, и это тоже решение.
 */
export function axisProblems(host: StageHost): string[] {
  const gates = host.gatesFile();
  if (gates === null || axesGateRow(gates) === null) return [];
  const plan = readArtifact(host.paths.plan);
  // Пустой массив означает «разбор доведён», поэтому отсутствие артефакта им быть не
  // может: молчание тут зеленило гейт по несуществующему плану.
  if (!plan.exists) return [`${host.paths.plan} не прочитан — разбор последствий проверять не по чему`];
  // Адресат исхода проверяется по РЕАЛЬНЫМ артефактам витка, иначе «claim-99» и
  // «гейт „Такого нет“» закрывают разбор за один ход (ревью).
  const intent = readArtifact(host.paths.intent);
  // Без задачи проверяются только имена гейтов — три адресата из четырёх не проверяются
  // вовсе, и гейт проходится словарём. Это отказ проверки, а не её зелёный исход.
  if (!intent.exists) {
    return [`${host.paths.intent} не прочитан — адресатов исходов проверять не по чему`];
  }
  // Пункты берём готовым `intentClaimLines()` — тем же разбором, которым живут выжимка
  // ретрая и добор клеймов: вторая копия «пробегись по строкам задачи» разошлась бы с
  // первой при первой же правке формы листа. Текст задачи ему передаётся, чтобы файл
  // не читался вторым разом внутри той же функции.
  const claimIds = [...host.intentClaimLines(intent.text).keys()];
  return planAxisProblems(plan.text, {
    claimIds,
    hasOpenQuestion: hasOpenQuestions(intent.text),
    hasInvariants: hasNamedInvariants(intent.text),
    enabledGates: gates.rows.filter((r) => r.enabled).map((r) => r.name),
  });
}

/**
 * Топ-ап осей плана: спросить модель ОДНИМ запросом по каждой оси, о которой секция
 * «Последствия шагов» ничего не сказала — см. докстринг `run/planAxisFill.ts`.
 *
 * Оси берутся из `unansweredAxes`, а не из `axisProblems()`: та ловит и СЕМАНТИЧЕСКИ
 * неверный ответ (ссылка на несуществующий claim/гейт) — топ-ап не переписывает решение,
 * которое модель уже приняла, пусть и сославшись на несуществующий адресат; такую строку
 * `finishGuard` укажет модели как прежде, а решать её человек должен видеть сам.
 */
export async function topUpAxes(host: StageHost, route: ResolvedRoute, system: string): Promise<void> {
  if (axesGateRow(host.gatesFile()) === null) return;
  const plan = readArtifact(host.paths.plan);
  if (!plan.exists) return;
  // План уже одобрен человеком (поле «Одобрение» в шапке) — топ-ап не переписывает
  // строки решения задним числом: одобрение принимается по прочитанному тексту, и
  // переписать таблицу осей после него значило бы подменить то, что человек одобрил.
  if (readDecision(plan.text, DECISION.approval).state === 'granted') return;
  const axes = unansweredAxes(plan.text);
  if (axes.length === 0) return;

  const intent = readArtifact(host.paths.intent);
  const claimIds = intent.exists ? [...host.intentClaimLines(intent.text).keys()] : [];
  const gates = host.gatesFile();
  const enabledGates = gates === null ? [] : gates.rows.filter((r) => r.enabled).map((r) => r.name);
  const exploration = readArtifact(host.paths.explorationReport);
  const axisSupportText = exploration.exists
    ? h2SectionRanges(exploration.text, /^опоры\s+осей$/i)
        .map((r) => exploration.text.slice(r.start, r.end).trim())
        .join('\n\n')
    : '';

  const limits = host.limits();
  // Форма добора — по ручке: пошаговый (одна степень свободы на вопрос) либо прежний
  // комбинированный; оба отдают один `PlanAxisFillResult` и пишутся одним путём ниже.
  const fill = route.planAxisFill === 'combined' ? fillPlanAxes : fillPlanAxesStepwise;
  const { answers, envFailure } = await fill({
    provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, host.trace('plan', 'planAxisFill')),
    model: route.model,
    params: route.params,
    system,
    axes,
    planText: plan.text,
    axisSupportText,
    claimIds,
    enabledGates,
    hasOpenQuestion: intent.exists ? hasOpenQuestions(intent.text) : false,
    hasInvariants: intent.exists ? hasNamedInvariants(intent.text) : false,
    signal: host.signal(),
    onProgress: (note) => host.emit({ type: 'warning', runId: host.id, stage: 'plan', message: `топ-ап осей: ${note}` }),
    onUsage: (usage) => host.accountOffPathUsage('plan', usage, route.providerDef.currency),
  });

  // Этап отменён, пока шёл добор: запрос одобрения после `Run.cancel` встал бы в уже
  // снятую очередь гейта и ждал бы человека вечно (code-review-all 2026-09-23).
  if (host.signal().aborted) return;
  if (answers.length > 0) {
    // Перечитываем план ПОСЛЕ `fillPlanAxes` — тот только что сделал долгий сетевой
    // запрос (минуты для локальных моделей), а `plan.text` снят ДО него. Строить запись
    // на устаревшей копии значило бы молча затереть ручную правку человека, внесённую,
    // пока модель отвечала (ревью) — та же причина, по которой одобрение плана тоже
    // проверяется заново, а не доверяет проверке в начале метода.
    const fresh = readArtifact(host.paths.plan);
    if (!fresh.exists || readDecision(fresh.text, DECISION.approval).state === 'granted') {
      if (envFailure !== null) throw new ProviderEnvError(envFailure);
      return;
    }
    const updated = applyAxisAnswers(fresh.text, answers);
    if (updated !== fresh.text) {
      // Запись — тем же путём, что у `applyRecords`: нормализованный `Write` через
      // политику и гейт одобрения. Второго места решения о доступе не появляется.
      const call: NormalizedCall = { kind: 'write', path: host.paths.plan, content: updated };
      const decision = await host.requestApproval({
        runId: host.id,
        stage: 'plan',
        requestId: host.syntheticRequestId('axis-fill'),
        toolName: 'Write',
        rawInput: { file_path: host.paths.plan, content: updated },
        call,
        ctx: host.policyContext('plan'),
      });
      if (decision.allowed) {
        const edited = (decision.updatedInput as Record<string, unknown> | null)?.['content'];
        writeArtifact(host.paths.plan, typeof edited === 'string' ? edited : updated);
        host.emit({
          type: 'warning',
          runId: host.id,
          stage: 'plan',
          message: `топ-ап осей: дописано ${answers.length} из ${axes.length}`,
        });
      }
    }
  }
  if (envFailure !== null) throw new ProviderEnvError(envFailure);
}

/** Only request and require the independent reviewer after the plan's hard gates pass. */
function preparationReviewReady(host: StageHost): boolean {
  if (!isPreparationV2(host.paths) || !readinessRun2(host.ctx()).ready) return false;
  const plan = readArtifact(host.paths.plan);
  if (!plan.exists) return false;
  const ctx = host.ctx();
  const requests = preparation(host.paths)?.requests ?? [];
  const testTarget = enforceIntentTestFileTarget(plan.text, readArtifact(host.paths.intent).text, ctx.paths.projectRoot, requests);
  return testTarget.text === plan.text &&
    filesToTouchProblem(ctx) === null &&
    planRequirementsProblem(ctx) === null &&
    planClarificationProblem(ctx) === null &&
    planMapProblem(ctx) === null &&
    planStepsProblem(ctx) === null &&
    planStepSampleTextProblem(ctx) === null &&
    planTouchDiscrepancyProblem(ctx) === null &&
    intentPlanBoundaryProblem(readArtifact(host.paths.intent).text, plan.text, ctx.paths.projectRoot) === null &&
    intentImplementationPathsProblem(readArtifact(host.paths.intent).text, plan.text, extractExplicitExportPaths(requests)) === null &&
    preparationPlanEvidenceProblem(host.paths, plan.text) === null &&
    axisProblems(host).length === 0;
}

/** Re-send the verified source cards from Explore so the plan author can reason from code. */
export function preparationSourceFacts(paths: StageHost['paths']): string | null {
  const state = preparation(paths);
  const evidence = state?.readEvidence?.filter((entry) => entry.stage === 'explore') ?? [];
  if (evidence.length === 0) return null;
  const files = new Map(readTree(paths.projectRoot).files.map((file) => [file.path.replace(/\\/gu, '/'), file]));
  const cards: string[] = [];
  const contractFacts: string[] = [];
  let remaining = 24_000;
  for (const entry of evidence) {
    if (remaining <= 0) break;
    const file = files.get(entry.path.replace(/\\/gu, '/'));
    if (file === undefined || sourceHash(file.text) !== entry.sourceHash) continue;
    const excerpt = capBytes(file.text, Math.min(8_000, remaining));
    remaining -= Buffer.byteLength(excerpt.text, 'utf8');
    cards.push(`### ${entry.path}\n${excerpt.text}${excerpt.text.length < file.text.length ? '\n[исходник обрезан]' : ''}`);
    const lines = file.text.split(/\r?\n/u);
    for (let i = 0; i < lines.length && contractFacts.length < 8; i++) {
      if (!/(?:snapshot|immutable|notStrictEqual|does not mutate|снимок|неизменяем|не мутирует|возвращает новый объект|новый объект)/iu.test(lines[i]!)) continue;
      const testDecl = entry.path.startsWith('test/')
        ? [...lines.slice(Math.max(0, i - 40), i + 1)].reverse().find((line) => /\b(?:it|test)\s*\(/u.test(line))
        : undefined;
      const symbolDecl = testDecl ??
        lines.slice(i, Math.min(lines.length, i + 6)).find((line) => /\bexport\s+(?:interface|type|function|class)\s+[\w$]+/u.test(line)) ??
        [...lines.slice(Math.max(0, i - 20), i + 1)].reverse().find((line) => /\bexport\s+(?:interface|type|function|class)\s+[\w$]+/u.test(line));
      const name = testDecl === undefined
        ? /\bexport\s+(?:interface|type|function|class)\s+([\w$]+)/u.exec(symbolDecl ?? '')?.[1] ?? 'source'
        : /\b(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/u.exec(testDecl)?.[1]?.trim().replace(/[^\p{L}\p{N}_$-]+/gu, '-') ?? 'test';
      const fact = `${entry.path}:${name} (L${i + 1}): ${lines[i]!.trim().slice(0, 280)}`;
      if (!contractFacts.includes(fact)) contractFacts.push(fact);
    }
  }
  if (cards.length === 0) return null;
  return [
    'Исходники, прочитанные рантаймом на этапе explore. Используй их для выбора подхода и укажи конкретное основание. Не выводи желаемое поведение только из текущей реализации.',
    ...(contractFacts.length > 0 ? ['Короткие выдержки о контрактах и неизменяемости (точные строки; используй их как отдельные проверяемые инварианты и покрой их тестами):', ...contractFacts] : []),
    ...cards,
  ].join('\n\n');
}

/** Feed concrete independent-review findings back into the next plan revision. */
export function preparationReviewFacts(paths: StageHost['paths']): string | null {
  const review = preparation(paths)?.review;
  if (review === undefined || review.issues.length === 0) return null;
  return [
    'Предыдущая независимая проверка нашла расхождения в прежней редакции. Сверь каждое замечание с исходным запросом и переданными исходниками; исправь подтверждённые ошибки и не принимай неподтверждённые выводы проверки как новые требования.',
    review.independent.trim(),
    ...review.issues.map((issue) => `- ${issue}`),
  ].filter(Boolean).join('\n\n');
}

/**
 * `files_to_touch` duplicates the paths already named by explicit plan steps. Compact
 * form filling can occasionally preserve only part of this duplicated list. Reconcile
 * missing allowlist entries from explicit steps; all normal
 * discrepancy, path, and new-file gates still validate the recovered entries.
 */
function reconcileTouchListFromSteps(host: StageHost): void {
  const plan = readArtifact(host.paths.plan);
  if (!plan.exists) return;
  const steps = extractExplicitSteps(plan.text);
  if (steps.length === 0) return;
  const allowlisted = new Set(extractFilesToTouch(plan.text));
  const entries = steps.map((step) => ({
    path: step.file,
    note: `${step.isNew ? 'новый файл — ' : ''}${step.action}`,
  }));
  const missing = entries.filter((entry) => !allowlisted.has(entry.path));
  if (missing.length === 0) return;
  const reconciled = allowlisted.size === 0
    ? seedFilesToTouch(plan.text, missing)
    : appendFilesToTouch(plan.text, missing);
  if (reconciled.text !== plan.text) host.writeAutofilled(host.paths.plan, reconciled.text, []);
}

export const planStage: StageDef = {
  id: 'plan',
  skill: 'sdlc-plan',
  title: 'План витка',
  // `Bash` в списке нет: поле «База» пишет рантайм (`autofillPlan`, `git rev-parse HEAD`
  // мимо модели), а остальное — та же причина, что на этапе 1: план — это документ, а не
  // прогон команд. Разведка, которой нужно смотреть в дерево, идёт этапом раньше и своими
  // инструментами чтения. (Устаревший комментарий «Bash — для git rev-parse HEAD в поле
  // «База»» утверждал обратное — найдено ревью `stage-review-2026-09-18.md`, S7.)
  tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'AskHuman', 'FinalizeArtifact', 'FillField'],
  subagents: [],
  produces: (c) => [c.paths.plan, c.paths.readiness, ...(isPreparationV2(c.paths) ? [c.paths.intent] : [])],
  requires: [
    {
      describe: 'отчёт разведки на месте (или мелкий контур)',
      artifact: (c) => c.paths.explorationReport,
      check: (c) =>
        isSmallContour(c) || artifactExists(c.paths.explorationReport)
          ? null
          : `нет файла ${c.paths.explorationReport}. На мелком контуре разведка не ` +
            `запускается — тогда пометь это в поле «Контур» задачи.`,
    },
    // Та же функция полноты, что у стража этапа 1 и входа в разведку (`intentFilled`): на
    // мелком контуре секцию «Что придётся тронуть» не заполняет никто, и требовать её здесь
    // значило бы блокировать план по файлу, который этап 1 честно закрыл.
    { ...intentFilled('задача заполнена без плейсхолдеров', true), check: (c) => intentFilled('задача заполнена', !isPreparationV2(c.paths)).check(c) },
    explorationPathsExist(),
    // И здесь тоже, не только на explore: мелкий контур пропускает разведку целиком
    // (`explore.skipIf`), и без этой строки его ветка `small ? 1 : 3` внутри проверки
    // была мертва — пустой лист доезжал до вердикта.
    claimsMinimum(),
    // Восьмое условие вердикта проверяется и на входе этапа 4: переписанная задача не
    // должна доехать до плана, а «уточнено с одобрения» — единственный законный путь.
    { ...intentSectionsIntact('задача не переписана внутри витка (снимок секций intent.md)'), check: (c) => isPreparationV2(c.paths) ? null : intentSectionsIntact('версия задачи').check(c) },
  ],
  // План здесь и создаётся, поэтому защищены только задача и набор гейтов.
  protectedArtifacts: (c) => [`${SDLC_DIR}/gates.md`, ...(isPreparationV2(c.paths) ? [] : [relOf(c, c.paths.intent)])],
  humanGate: { artifact: 'plan', label: DECISION.approval },
  skipIf: null,
};

export const planModule: StageModule = {
  tracksPreparationReads: true,
  repairFeedback: (host) => {
    if (readGuided(host.paths) === null) return null;
    const review = preparation(host.paths)?.review;
    const problem = preparationReviewProblem(host.paths);
    return problem && review?.completed && review.issues.length > 0
      ? `Независимое ревью вернуло план на ремонт: ${problem}` : null;
  },
  def: planStage,
  runtimeFacts: [{ id: 'indexed-callers', purpose: 'вызывающие экспортируемых символов из файлов files_to_touch', freshness: 'live' }],
  formFillExecutor: true,
  leanDocTools: true,
  mechanicalJobs: (host) => {
    const date = new Date().toISOString().slice(0, 10);
    return [
      {
        path: host.paths.plan,
        fill: async (t) => {
          const head = await host.head();
          const intent = readArtifact(host.paths.intent);
          const clarification = readArtifact(host.paths.clarificationReport);
          const originalRequests = preparation(host.paths)?.requests ?? [];
          const explicitExports = extractExplicitExportPaths(originalRequests);
          const acceptanceChecks = intent.exists ? acceptanceChecksFromIntent(intent.text) : [];
          const autofilled = autofillPlan(t, {
            title: host.slug,
            explorationDone: artifactExists(host.paths.explorationReport),
            clarificationDone: artifactExists(host.paths.clarificationReport),
            base: head.sha ?? head.why,
            requirementsHash: resolvedRequirementsHash(
              intent.exists ? intent.text : '',
              clarification.exists ? clarification.text : '',
            ),
            acceptanceChecks,
          });
          // Засев files_to_touch (4.1, «П»-половина): модель решает по готовой строке
          // (оставить/исключить/добавить), а не составляет список с нуля. Идемпотентно —
          // см. докстринг `seedFilesToTouch`.
          const touch = intent.exists ? touchListEntries(intent.text) : [];
          const seeded = seedFilesToTouch(autofilled.text, touch);
          const prepared = intent.exists
            ? preparePlanImplementationCards(
                seeded.text,
                intent.text,
                host.ctx().paths.projectRoot,
                explicitExports,
                originalRequests,
              )
            : { text: seeded.text, paths: [] as string[] };
          // All existing files_to_touch rows need an explicit execution card. Create those
          // cards before the model sees Plan; adding them after its turn leaves new required
          // fields that the model had no chance to fill (r65: Qwen stopped with 26 placeholders).
          const scaffolded = appendMissingPlanStepCards(prepared.text);
          return {
            text: scaffolded.text,
            filled: autofilled.filled + seeded.seeded + prepared.paths.length + scaffolded.paths.length,
          };
        },
      },
      { path: host.paths.readiness, fill: async (t) => autofillReadiness(t, { title: host.slug, date, run: 2 }) },
    ];
  },
  checksBranchOnEntry: true,
  begin: (host, route) => ({
    enterFacts: async () => {
      const ctx = host.ctx();
      const callers = callersBlock(ctx);
      const clarification = readArtifact(ctx.paths.clarificationReport);
      const resolutions = clarificationResolutionBlock(clarification.exists ? clarification.text : '', isPreparationV2(host.paths));
      const sources = isPreparationV2(host.paths) ? preparationSourceFacts(host.paths) : null;
      const review = isPreparationV2(host.paths) ? preparationReviewFacts(host.paths) : null;
      return [callers, resolutions, sources, review].filter((fact): fact is string => fact !== null);
    },
    // Снимка секций задачи может не быть (виток начат до его появления или с середины по
    // снимку артефактов) — тогда он снимается здесь, с предупреждением: с этого момента
    // задача под сверкой, а что было до — не проверено.
    afterStart: async () => {
      if (isPreparationV2(host.paths)) return;
      ensureIntentSnapshot(host, 'plan');
    },

    // Новая редакция плана — новое одобрение (`SDLC.md` → «Раскладка артефактов»): прежняя
    // одобренная редакция перед перезаписью переименовывается в `plan-v‹K›.md` КАК ЕСТЬ —
    // с подписью человека под той редакцией, которую он одобрял, — а свежий `plan.md`
    // раскладывается формой с пустым полем «Одобрение». До раскладки форм: иначе
    // существующий одобренный план остался бы «планом» и правился бы поверх подписи.
    beforeSeed: async () => {
      const plan = readArtifact(host.paths.plan);
      if (!plan.exists) return;
      if (readDecision(plan.text, DECISION.approval).state !== 'granted') return;
      let k = 1;
      while (artifactExists(host.paths.planArchive(k))) k += 1;
      renameSync(host.paths.plan, host.paths.planArchive(k));
      host.emit({
        type: 'warning',
        runId: host.id,
        stage: 'plan',
        message:
          `одобренная редакция плана переименована в ${host.paths.planArchive(k)} как есть; новый plan.md ` +
          'раскладывается формой — одобрение прежней редакции на него не переносится',
      });
    },

    // Топ-ап осей плана (`ModelDef.planAxisFill`): оси, о которых секция «Последствия
    // шагов» ничего не сказала, добираются узкими вопросами рантайма. До стража завершения
    // этапа — он увидит меньше проблем, если топ-ап уже закрыл часть строк.
    afterTurn: async (stagePrompt, signal) => {
      if (route.flow === 'loop' && route.planAxisFill !== false && !signal.aborted && !isPreparationV2(host.paths)) {
        await topUpAxes(host, route, stagePrompt.system);
      }
    },
    afterForm: async (_prompt, _def, _agents, hooks) => {
      if (isPreparationV2(host.paths)) {
        reconcileTouchListFromSteps(host);
        // The requirements hash is part of planContentHash/fingerprint. Write it
        // before the independent review so finishProblem cannot immediately make
        // a fresh review stale by adding this mechanical field afterward.
        const draft = readArtifact(host.paths.plan);
        if (draft.exists && readRequirementsHash(draft.text) === null) {
          const intent = readArtifact(host.paths.intent);
          const clarification = readArtifact(host.paths.clarificationReport);
          const hash = resolvedRequirementsHash(intent.exists ? intent.text : '', clarification.exists ? clarification.text : '');
          host.writeAutofilled(host.paths.plan, addRequirementsHash(draft.text, hash), []);
        }
        syncCanonicalPreparation(host.paths);
      }
      if (!host.signal().aborted && preparationReviewReady(host)) {
        await reviewPreparation(host, hooks);
      }
    },
    outcomeProblem: () => preparationReviewReady(host) ? preparationReviewProblem(host.paths) : null,

    // Разбор последствий — тем же приёмом и по той же причине, что карта разведки:
    // находка нужна модели в её собственном ходу. Предусловием этапа 5 она пришла бы
    // после ухода планировщика, а дописывать исход за него стало бы некому — кроме
    // самого исполнителя, которому решение человека не принадлежит.
    finishProblem: () => {
      if (isPreparationV2(host.paths)) {
        const state = preparation(host.paths);
        const problem = requirementProblem(readArtifact(host.paths.intent).text,
          state?.version === 3 && state.structuredTablesRendered === true ? state.canonical?.requirements : undefined);
        if (problem !== null) return problem;
        const plan = readArtifact(host.paths.plan);
        if (plan.exists) {
          const evidenceProblem = preparationPlanEvidenceProblem(host.paths, plan.text);
          if (evidenceProblem !== null) return evidenceProblem;
        }
      }
      const readinessResult = readinessRun2(host.ctx());
      const readiness = readArtifact(host.paths.readiness);
      const runtimeChecklist = readiness.exists && hasRuntimeReadiness(readiness.text);
      if (runtimeChecklist) {
        const date = new Date().toISOString().slice(0, 10);
        const updated = autofillReadiness(readiness.text, {
          title: host.slug, date, run: 2, checks: readinessResult.checks,
          verdict: readinessResult.ready ? 'ready' : 'not',
        });
        if (updated.text !== readiness.text) host.writeAutofilled(host.paths.readiness, updated.text, []);
      }
      // Пустой files_to_touch — раньше axisProblems: без адресов правки разбор
      // последствий по осям тоже не может ссылаться на реальные пути, но само по
      // себе отсутствие files_to_touch — более фундаментальная и более дешёвая в
      // проверке находка (см. filesToTouchProblem).
      const intentText = readArtifact(host.paths.intent).text;
      let currentPlanForIntent = readArtifact(host.paths.plan);
      if (readGuided(host.paths) && currentPlanForIntent.text.includes('<!-- guided:no-change -->') && extractFilesToTouch(currentPlanForIntent.text).length === 0) {
        return readinessResult.ready ? null : readinessResult.checks;
      }
      if (currentPlanForIntent.exists) {
        const enforcedTest = enforceIntentTestFileTarget(
          currentPlanForIntent.text,
          intentText,
          host.ctx().paths.projectRoot,
          preparation(host.paths)?.requests ?? [],
        );
        if (enforcedTest.changed) {
          host.writeAutofilled(host.paths.plan, enforcedTest.text, []);
          return (
            `Рантайм восстановил заданный новый тестовый файл ${enforcedTest.path} и отдельную карточку тестов; ` +
            'существующие тесты исключены из allowlist по границе Intent. Продолжи планирование, сохрани этот путь новым.'
          );
        }
        currentPlanForIntent = readArtifact(host.paths.plan);
      }
      if (currentPlanForIntent.exists) {
        const planned = new Set(extractFilesToTouch(currentPlanForIntent.text).map((path) => path.replace(/\\/gu, '/')));
        const required = extractIntentImplementationPaths(intentText).filter((path) => !planned.has(path));
        if (required.length > 0) {
          const projectRoot = host.ctx().paths.projectRoot;
          const additions = required.map((path) => ({
            path,
            note: `${existsSync(join(projectRoot, path)) ? 'существующий' : 'новый'} файл из «Что делаем»; опиши конкретное изменение`,
          }));
          const restored = appendFilesToTouch(currentPlanForIntent.text, additions);
          if (restored.appended > 0) {
            const scaffolded = appendMissingPlanStepCards(restored.text);
            host.writeAutofilled(host.paths.plan, scaffolded.text, []);
            return (
              `Рантайм вернул в files_to_touch явные цели реализации из «Что делаем»: ${required.join(', ')}. ` +
              `Добавлены отдельные карточки для отсутствующих путей: ${scaffolded.paths.join(', ') || 'карточки уже были'}. ` +
              'Заполни для каждой карточки символ, действие, claims, проверку, контракт и зависимости до одобрения плана.'
            );
          }
        }
      }
      const filesProblem = filesToTouchProblem(host.ctx());
      if (filesProblem !== null) return filesProblem;
      const boundaryProblem = intentPlanBoundaryProblem(
        intentText,
        readArtifact(host.paths.plan).text,
        host.ctx().paths.projectRoot,
      );
      if (boundaryProblem !== null) return boundaryProblem;
      const intentPathProblem = intentImplementationPathsProblem(
        intentText,
        readArtifact(host.paths.plan).text,
        extractExplicitExportPaths(preparation(host.paths)?.requests ?? []),
      );
      if (intentPathProblem !== null) return intentPathProblem;
      const touchProblem = planTouchDiscrepancyProblem(host.ctx());
      if (touchProblem !== null) return touchProblem;
      const currentPlan = readArtifact(host.paths.plan);
      if (currentPlan.exists) {
        const scaffolded = appendMissingPlanStepCards(currentPlan.text);
        if (scaffolded.paths.length > 0) {
          host.writeAutofilled(host.paths.plan, scaffolded.text, []);
          return (
            `Добавлены пустые карточки плана для разрешённых файлов без отдельного шага: ` +
            `${scaffolded.paths.join(', ')}. Заполни поля каждой новой карточки: действие, символ, ` +
            `claims, проверка и контракт; затем пересверь шаги с files_to_touch.`
          );
        }
      }
      const stepProblem = planStepsProblem(host.ctx());
      if (stepProblem !== null) return stepProblem;
      const sampleProblem = planStepSampleTextProblem(host.ctx());
      if (sampleProblem !== null) return sampleProblem;
      const mapProblem = planMapProblem(host.ctx());
      if (mapProblem !== null) return mapProblem;
      const requirementsProblem = planRequirementsProblem(host.ctx());
      if (requirementsProblem !== null) return requirementsProblem;
      const clarificationProblem = planClarificationProblem(host.ctx());
      if (clarificationProblem !== null) return clarificationProblem;
      const problems = axisProblems(host);
      if (problems.length === 0 && (!runtimeChecklist || readinessResult.ready)) return null;
      if (problems.length === 0) return `проверки готовности прогона 2 не пройдены: ${readinessResult.checks}`;
      return [
        'секция «Последствия шагов» плана не доведена:',
        ...problems.map((p) => `- ${p}`),
        // Подписи под принятым риском в форме НЕТ намеренно: риск принимается полем
        // «Одобрение» плана, а подписная колонка была бы вторым каналом решения,
        // которого у человека в этом файле нет. Требуя подпись, страж гнал модель
        // дописывать колонку, которой в шаблоне эталона не существует (ревью).
        'Исход — из закрытого словаря: claim-N, инвариант, гейт «имя», принятый риск ' +
          '(с причиной и сроком возврата), следующий виток либо «н/п — почему». Совет ' +
          'свободным текстом исходом не является: у него нет исполнителя.',
      ].join('\n');
    },
  }),
};
