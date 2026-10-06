import { readArtifact } from '../artifacts/artifact.ts';
import { preparation, preparationReferencedCodePaths, savePreparation, preparationFingerprint, preparationReviewProblem, section, sourceHash, reviewSourcesCurrent } from '../artifacts/preparation.ts';
import type { ExecHooks } from '../exec/StageExecutor.ts';
import type { StageHost } from './stages/types.ts';
import { extractHumanFacts } from '../artifacts/humanFacts.ts';
import { readTree } from '../explore/tree.ts';
import { capBytes } from '../prompt/bytes.ts';

function parseReviewJson(text: string): unknown {
  const raw = text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '').trim();
  try { return JSON.parse(raw); }
  catch (error) {
    // Normalize only the single extra closing brace observed in model output.
    // Any other malformed JSON remains a visible protocol failure.
    if (!raw.endsWith('}}')) throw error;
    return JSON.parse(raw.slice(0, -1));
  }
}

export function parsePreparationReview(text: string): string[] {
  const value = parseReviewJson(text);
  if (typeof value !== 'object' || value === null || !('issues' in value) || !Array.isArray(value.issues)) {
    throw new Error('ожидался JSON {"issues": ["конкретное расхождение и контрпример"]}');
  }
  return value.issues.map((issue: unknown) => {
    if (typeof issue === 'string' && issue.trim() !== '') return issue.trim();
    if (typeof issue !== 'object' || issue === null) throw new Error('замечание должно быть строкой или объектом с issue/defect');
    const item = issue as Record<string, unknown>;
    const finding = [item.issue, item.defect].find((part): part is string => typeof part === 'string' && part.trim() !== '');
    if (finding === undefined) throw new Error('объект замечания должен содержать непустое issue или defect');
    const details = [
      typeof item.basis === 'string' && item.basis.trim() !== '' ? `Основание: ${item.basis.trim()}` : '',
      typeof item.location === 'string' && item.location.trim() !== '' ? `Место плана: ${item.location.trim()}` : '',
      typeof item.counterexample === 'string' && item.counterexample.trim() !== '' ? `Контрпример: ${item.counterexample.trim()}` : '',
    ].filter(Boolean);
    return [finding.trim(), ...details].join(' — ');
  });
}

export function preparationReviewResponseFormat(kind: 'scenarios' | 'issues'): Record<string, unknown> {
  const sentence = { type: 'string', minLength: 1, maxLength: 1000 };
  const item = kind === 'scenarios'
    ? { type: 'object', properties: { scenario: sentence, incorrectBehavior: sentence, basis: sentence },
        required: ['scenario', 'incorrectBehavior', 'basis'], additionalProperties: false }
    : { type: 'object', properties: { issue: sentence, basis: sentence, location: sentence, counterexample: sentence },
        required: ['issue', 'basis', 'location', 'counterexample'], additionalProperties: false };
  return { type: 'json_schema', json_schema: { name: `preparation_review_${kind}`, strict: true,
    schema: { type: 'object', properties: { [kind]: { type: 'array', items: item } }, required: [kind], additionalProperties: false } } };
}

export function parseIndependentScenarios(text: string): { scenario: string; incorrectBehavior: string; basis: string }[] {
  const value = parseReviewJson(text);
  if (typeof value !== 'object' || value === null || !('scenarios' in value) || !Array.isArray(value.scenarios) ||
    !value.scenarios.every((item: unknown) => typeof item === 'object' && item !== null &&
      'scenario' in item && typeof item.scenario === 'string' && item.scenario.trim() !== '' &&
      'incorrectBehavior' in item && typeof item.incorrectBehavior === 'string' && item.incorrectBehavior.trim() !== '' &&
      'basis' in item && typeof item.basis === 'string' && item.basis.trim() !== '')) {
    throw new Error('ожидался JSON {"scenarios": [{"scenario": "...", "incorrectBehavior": "...", "basis": "..."}]}');
  }
  return value.scenarios as { scenario: string; incorrectBehavior: string; basis: string }[];
}

/** Два свежих вызова: сначала понимание без плана, затем сравнение. Инструменты и история автора отсутствуют. */
export async function reviewPreparation(host: StageHost, hooks: ExecHooks): Promise<string | null> {
  const state = preparation(host.paths);
  if (state === null) return null;
  const fingerprint = preparationFingerprint(host.paths);
  if (state.review?.completed && state.review.fingerprint === fingerprint && reviewSourcesCurrent(host.paths, state.review)) return preparationReviewProblem(host.paths);
  // Маршрут рецензента — тот же, что у скана этапа 6 (`reviewScan`): отдельный
  // `reviewModel` из конфига раннера, если задан, иначе маршрут verify. На вердикт это
  // ревью не влияет ни при каком маршруте — это внутренний фильтр качества плана.
  const route = { ...host.reviewScan().route, formFill: false, reviewFill: false, stepFill: false, exploreFill: false };
  const signal = host.signal();
  const reviewHooks: ExecHooks = {
    ...hooks,
    onUsage: (usage) => host.accountOffPathUsage('plan', usage, route.providerDef.currency),
    // The reviewer gets the original sources in its prompt and may verify a citation
    // with bounded read-only tools. Never let this independent pass write or execute.
    onToolRequest: async (_call, meta) => ['Read', 'Glob', 'Grep'].includes(meta.toolName)
      ? ({ allowed: true, updatedInput: null, by: 'policy' })
      : ({ allowed: false, reason: 'independent preparation review is read-only', by: 'policy' }),
    onAskHuman: async () => ({}),
    onRecord: () => 'запись недоступна; верни результат текстом',
  };
  const run = async (system: string, user: string, kind: 'scenarios' | 'issues' = system.includes('"scenarios"') ? 'scenarios' : 'issues') => {
    system = `ФАЗА: ДО РЕАЛИЗАЦИИ. Chunk ещё не запускался. Исходники — базовое состояние, а план — будущие действия. Отсутствие запланированного нового файла, экспорта или теста в текущем коде ожидаемо и не является дефектом плана. Проверяй, предусмотрены ли нужное действие и проверка в карточках плана. Не требуй уже выполненного изменения до реализации.\nСверяй каждую пару procedure/expected из Intent с исходным запросом: корректный вход не должен ошибочно ожидать отказ, некорректный — успех. План не отменяет ошибку требования или ожидаемого результата в Intent.\nYou may use Read, Glob, or Grep only to verify source evidence. These tools are read-only and limited to the project. Do not request writes, shell commands, or human input. Return the requested JSON after checking.\n\n${system}${kind === 'issues' ? '\nФормат: {"issues":[{"issue":"конкретный пропуск плана","basis":"цитата исходного требования","location":"заголовок карточки/секции и дословная цитата из ПЛАНА","counterexample":"неверное поведение, допускаемое именно этим планом"}]}. Для замечания о тесте сверь его проверку И ожидаемый результат. Не называй отсутствие слова дефектом, если конкретная проверка уже ловит ошибочное поведение. Пустой список: {"issues":[]}.' : ''}`;
    let capturedAnswer = '';
    let invalidCapturedAnswer: unknown = null;
    const runHooks: ExecHooks = {
      ...reviewHooks,
      onToolRequest: async (call, meta) => {
        if (meta.toolName === 'Write' && typeof meta.rawInput['content'] === 'string') {
          const content = meta.rawInput['content'] as string;
          try {
            parseReviewJson(content);
            capturedAnswer = content;
          } catch (error) {
            // A model may try to write an artifact instead of returning the
            // requested review JSON. Never treat arbitrary file content as a
            // completed review; keep the protocol failure visible instead.
            invalidCapturedAnswer = error;
          }
          return { allowed: false, reason: 'Answer text captured; writes are disabled for independent review.', by: 'policy' };
        }
        return reviewHooks.onToolRequest(call, meta);
      },
    };
    const prompt = { system, user, tools: [], editedByOperator: false, presetNote: null };
    host.emit({ type: 'model_exchange', runId: host.id, stage: 'plan', question: user, answer: 'независимая проверка проработки: запрос подготовлен' });
    const reviewRoute = { ...route, params: { ...(route.params ?? {}), response_format: preparationReviewResponseFormat(kind) } };
    const result = await host.executorFor('plan', reviewRoute, false).run({
      prompt, cwd: host.projectRoot, model: route.model, allowedTools: ['Read', 'Glob', 'Grep'],
      readOnlyDirs: [host.projectRoot], subagents: [], mcp: null,
      finishGuard: null, salvageFromText: null, maxTurns: 6, maxBudgetUsd: host.maxBudgetUsd,
      spentUsdBefore: host.spentBefore(route.providerDef.currency ?? 'USD'), signal,
    }, runHooks);
    if (signal.aborted) throw new Error('independent review cancelled');
    if (capturedAnswer.trim() !== '') return capturedAnswer;
    if (!result.ok || result.finalText.trim() === '') {
      throw new Error(invalidCapturedAnswer === null
        ? result.note ?? 'независимая проверка не завершена'
        : `independent review wrote non-JSON content: ${String(invalidCapturedAnswer)}`);
    }
    return result.finalText;
  };
  const exploration = readArtifact(host.paths.explorationReport).text;
  const facts = ['Карта кодовой базы', 'Найдено для переиспользования', 'Опоры осей', 'Границы разведки'].map((name) => `### ${name}\n${section(exploration, name)}`).join('\n\n');
  // Исходники читает рантайм через общий безопасный индекс; .sdlc и внешние симлинки исключены.
  const index = readTree(host.projectRoot);
  const namedInRequest = new Set(state.requests.flatMap(preparationReferencedCodePaths));
  const candidates = index.files.filter((file) => facts.includes(file.path) || namedInRequest.has(file.path.toLocaleLowerCase()));
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
  const requestContext = ['Исходные запросы (дословно):', ...state.requests, 'Ответы человека:', answers].join('\n\n');
  const original = [requestContext, 'Факты исследования; выводы автора могут быть ошибочны:', facts, 'Базовые исходники ДО реализации, прочитанные рантаймом:', ...sources].join('\n\n');
  let independent = '';
  try {
    if (state.requests.length === 0) throw new Error('исходный запрос не сохранён: вернись к intent и передай формулировку задачи');
    const scenarios = parseIndependentScenarios(await run(
      'Независимо восстанови цель, границы, неоднозначности и важные сценарии приёмки только из исходного запроса, ответов человека и первоисточников. Ты не видел требований и плана автора. Верни ТОЛЬКО JSON вида {"scenarios":[{"scenario":"...","incorrectBehavior":"...","basis":"..."}]}. По одному объекту на существенный сценарий; каждое поле — одно короткое предложение. Укажи только неверное поведение, которое следует обнаружить, и точное основание. Не пересказывай код и не повторяй одинаковые сценарии.', original));
    independent = JSON.stringify(scenarios);
    const text = await run('Проверь требования и план против независимого разбора и первоисточников. Найди потерянное намерение, выдуманное требование, скрытое предположение, неучтённый ответ человека, неопределённый сценарий или тест, пропускающий неверную реализацию. В независимом разборе поле incorrectBehavior описывает ошибочную реализацию, которую сценарий должен поймать; это не утверждение требований или плана. Замечание допустимо только если конкретный шаг/проверка плана действительно пропускает эту ошибку. Не сообщай дефектом ошибку или двусмысленность самого независимого разбора. Каждый дефект обоснуй точной цитатой/адресом из источника, местом в плане и контрпримером. Существующий код не определяет желаемое поведение. Перед добавлением замечания сверь его с исходным запросом: НЕ сообщай как дефект поведение, которое запрос прямо исключает, и не требуй проверок/изменений, запрещённых его рамками. Если запрос оставил выбор реализации Плану, оцени выбранный вариант по контрактам, не называй сам выбор пропуском намерения. Верни только JSON {"issues": ["конкретный дефект, основание, место плана, контрпример"]}; пустой список означает отсутствие найденных существенных расхождений, а не доказанную полноту.',
      [original, 'Независимый разбор:', independent, 'Актуальные требования:', readArtifact(host.paths.intent).text,
        'Предыдущая подтверждённая редакция (если была); проверь причины удаления и переопределения ID:', state.revisions.at(-1)?.intent ?? 'первая редакция',
        'План:', readArtifact(host.paths.plan).text].join('\n\n'));
    let issues = parsePreparationReview(text);
    if (issues.length > 0) {
      // Критик модели иногда превращает само ожидаемое ошибочное поведение из сценария
      // в дефект плана, даже когда шаги уже требуют сохранить это поведение. Перед красным
      // исходом повторно сверяем только найденные замечания с задачей и точным текстом плана.
      const adjudication = await run(
        'Ты — арбитр замечаний, предыдущий критик мог ошибиться. Для каждого замечания проверь исходный запрос и конкретные шаги/проверки плана. Поле incorrectBehavior описывает ошибочную реализацию, а не поведение плана. Оставь замечание только если план действительно допускает указанный дефект. Удали всё, что запрос прямо запрещает, что уже покрыто планом/проверкой, или где критик неверно прочёл сценарий. Не добавляй новых замечаний. Верни только JSON {"issues": ["подтверждённый пропуск, цитата задачи, место плана, контрпример"]}; если замечания не подтверждаются — {"issues":[]}.',
        [requestContext, 'Независимые сценарии:', independent, 'Требования:', readArtifact(host.paths.intent).text,
          'План:', readArtifact(host.paths.plan).text, 'Замечания для проверки:', JSON.stringify(issues)].join('\n\n'),
      );
      issues = parsePreparationReview(adjudication);
    }
    const review = { fingerprint, independent, issues, completed: true, sourceHashes };
    if (fingerprint !== preparationFingerprint(host.paths) || !reviewSourcesCurrent(host.paths, review)) throw new Error('источники изменились во время проверки; нужен повтор');
    savePreparation(host.paths, { ...state, review });
  } catch (error) {
    savePreparation(host.paths, { ...state, review: { fingerprint, independent, issues: [String(error)], completed: false } });
    return `проверка проработки не завершена: ${String(error)}`;
  }
  return preparationReviewProblem(host.paths);
}
