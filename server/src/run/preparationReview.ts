import { readArtifact } from '../artifacts/artifact.ts';
import { preparation, savePreparation, preparationFingerprint, preparationReviewProblem, section, sourceHash, reviewSourcesCurrent } from '../artifacts/preparation.ts';
import type { ExecHooks } from '../exec/StageExecutor.ts';
import type { StageHost } from './stages/types.ts';
import { extractHumanFacts } from '../artifacts/humanFacts.ts';
import { readTree } from '../explore/tree.ts';
import { capBytes } from '../prompt/bytes.ts';

export function parsePreparationReview(text: string): string[] {
  const raw = text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || !('issues' in value) || !Array.isArray(value.issues) ||
    !value.issues.every((issue: unknown) => typeof issue === 'string' && issue.trim().length > 0)) throw new Error('ожидался JSON {"issues": ["конкретное расхождение и контрпример"]}');
  return value.issues as string[];
}

/** Два свежих вызова: сначала понимание без плана, затем сравнение. Инструменты и история автора отсутствуют. */
export async function reviewPreparation(host: StageHost, hooks: ExecHooks): Promise<string | null> {
  const state = preparation(host.paths);
  if (state === null) return null;
  const fingerprint = preparationFingerprint(host.paths);
  if (state.review?.completed && state.review.fingerprint === fingerprint && reviewSourcesCurrent(host.paths, state.review)) return preparationReviewProblem(host.paths);
  const route = { ...host.verifyRoute(), formFill: false, reviewFill: false, stepFill: false, exploreFill: false };
  const signal = host.signal();
  const reviewHooks: ExecHooks = {
    ...hooks,
    onUsage: (usage) => host.accountOffPathUsage('plan', usage, route.providerDef.currency),
    onToolRequest: async () => ({ allowed: false, reason: 'проверка проработки выполняется без инструментов', by: 'policy' }),
    onAskHuman: async () => ({}),
    onRecord: () => 'запись недоступна; верни результат текстом',
  };
  const run = async (system: string, user: string) => {
    const prompt = { system, user, tools: [], editedByOperator: false, presetNote: null };
    host.emit({ type: 'model_exchange', runId: host.id, stage: 'plan', question: user, answer: 'независимая проверка проработки: запрос подготовлен' });
    const result = await host.executorFor('plan', route).run({
      prompt, cwd: host.projectRoot, model: route.model, allowedTools: [], readOnlyDirs: [], subagents: [], mcp: null,
      finishGuard: null, salvageFromText: null, maxTurns: 1, maxBudgetUsd: host.maxBudgetUsd,
      spentUsdBefore: host.spentBefore(route.providerDef.currency ?? 'USD'), signal,
    }, reviewHooks);
    if (!result.ok || result.finalText.trim() === '' || signal.aborted) throw new Error(result.note ?? 'независимая проверка не завершена');
    return result.finalText;
  };
  const exploration = readArtifact(host.paths.explorationReport).text;
  const facts = ['Карта кодовой базы', 'Найдено для переиспользования', 'Опоры осей', 'Границы разведки'].map((name) => `### ${name}\n${section(exploration, name)}`).join('\n\n');
  // Исходники читает рантайм через общий безопасный индекс; .sdlc и внешние симлинки исключены.
  const index = readTree(host.projectRoot);
  const candidates = index.files.filter((file) => facts.includes(file.path));
  let sourceBudget = 48_000;
  const sources: string[] = [];
  const sourceHashes: Record<string, string> = {};
  for (const file of candidates) {
    if (sourceBudget <= 0) break;
    const excerpt = capBytes(file.text, Math.min(12_000, sourceBudget));
    sourceBudget -= Buffer.byteLength(excerpt.text, 'utf8');
    sourceHashes[file.path] = sourceHash(file.text);
    sources.push(`### ${file.path}\n${excerpt.text}${excerpt.text.length < file.text.length ? '\n[файл обрезан; полнота чтения не подтверждена]' : ''}`);
  }
  sources.push(`Границы независимого чтения: ${sources.length} из ${candidates.length} адресованных файлов; индекс пропустил ${index.skipped.files} файлов. Неподтверждённый существенный факт укажи как неизвестное.`);
  const answers = extractHumanFacts(readArtifact(host.paths.clarificationReport).text).map((fact) => `${fact.question}\n${fact.answer}`).join('\n\n');
  const original = ['Исходные запросы (дословно):', ...state.requests, 'Ответы человека:', answers, 'Факты исследования; выводы автора могут быть ошибочны:', facts, 'Исходники, прочитанные рантаймом:', ...sources].join('\n\n');
  let independent = '';
  try {
    if (state.requests.length === 0) throw new Error('исходный запрос не сохранён: вернись к intent и передай формулировку задачи');
    independent = await run('Независимо восстанови цель, границы, неоднозначности и сценарии приёмки из исходного запроса и фактов. Не придумывай обязательств. Для каждого важного сценария назови неверное поведение, которое следует обнаружить. Ты не видел требований и плана автора.', original);
    const text = await run('Проверь требования и план против независимого разбора и первоисточников. Найди потерянное намерение, выдуманное требование, скрытое предположение, неучтённый ответ человека, неопределённый сценарий или тест, пропускающий неверную реализацию. Каждый дефект обоснуй цитатой/адресом и контрпримером. Существующий код не определяет желаемое поведение. Верни только JSON {"issues": ["конкретный дефект, основание, контрпример"]}; пустой список означает отсутствие найденных существенных расхождений, а не доказанную полноту.',
      [original, 'Независимый разбор:', independent, 'Актуальные требования:', readArtifact(host.paths.intent).text,
        'Предыдущая подтверждённая редакция (если была); проверь причины удаления и переопределения ID:', state.revisions.at(-1)?.intent ?? 'первая редакция',
        'План:', readArtifact(host.paths.plan).text].join('\n\n'));
    const issues = parsePreparationReview(text);
    const review = { fingerprint, independent, issues, completed: true, sourceHashes };
    if (fingerprint !== preparationFingerprint(host.paths) || !reviewSourcesCurrent(host.paths, review)) throw new Error('источники изменились во время проверки; нужен повтор');
    savePreparation(host.paths, { ...state, review });
  } catch (error) {
    savePreparation(host.paths, { ...state, review: { fingerprint, independent, issues: [String(error)], completed: false } });
    return `проверка проработки не завершена: ${String(error)}`;
  }
  return preparationReviewProblem(host.paths);
}
