/** Этап 2 — разведка: определение этапа и проверка фактичности отчёта разведки. */

import { DECISION, pathExistsAny, readArtifact } from '../../artifacts/artifact.ts';
import { SDLC_DIR } from '../../artifacts/paths.ts';
import { columnIndex, h2SectionRanges, parseTables } from '../../md/table.ts';
import { claimsMinimum, exists, filledExceptTouchSection, isSmallContour, relOf } from './preconditions.ts';
import type { Precondition, StageContext, StageDef, StageHost, StageModule } from './types.ts';
import { autofillTitle } from '../formAutofill.ts';
import { edgeExampleLines } from '../../artifacts/edgeExample.ts';
import type { ResolvedRoute } from '../../config/schema.ts';
import { ExploreExecutor } from '../../exec/ExploreExecutor.ts';
import { loadSubagent } from '../../exec/subagents.ts';
import { cardBudgetPerFile, fileCard, packCards } from '../../explore/cards.ts';
import type { AuthorClaim } from '../../explore/compare.ts';
import { intentKeywords } from '../../explore/keywords.ts';
import { INDEX_BLOCK_BYTES, renderIndexBlock } from '../../explore/render.ts';
import { readTree } from '../../explore/tree.ts';
import { buildView, type EcosystemLine } from '../../explore/view.ts';
import { gateKey } from '../../gates/gatesFile.ts';
import type { GateRow, GatesFile } from '../../gates/gatesFile.ts';
import { ProviderEnvError } from '../../provider/ChatProvider.ts';
import { createProvider } from '../../provider/registry.ts';
import { claimTextCell } from '../../verdict/retryBrief.ts';
import { deriveClaimsBlind, intentSectionsForBlind } from '../claimsBlind.ts';
import { briefFromIntent, titleFromIntent } from '../exploreAutofill.ts';
import type { BlindClaimsResult } from '../claimsBlind.ts';
import type { Keywords } from '../../explore/keywords.ts';
import type { ExploreIndex } from '../../explore/types.ts';
import type { BuiltView } from '../../explore/view.ts';

/**
 * Объявлен ли путь строки как будущий — то есть его отсутствие в дереве законно.
 *
 * Словарь — формы, которыми это пишут люди и модели: «новый», «отсутствует»,
 * «не существует», «будет создан», «создать», «создаётся». Проверяется каждая ячейка
 * строки: пометка стоит там, где автору удобно, а не в колонке, которую мы назначили.
 */
export function declaredAsNew(row: readonly string[]): boolean {
  return row.some((cell) => {
    const t = (cell ?? '').toLowerCase().replace(/ё/g, 'е');
    if (/(^|[^\p{L}])нов/u.test(t)) return true;
    if (/(^|[^\p{L}])создат|(^|[^\p{L}])создан|(^|[^\p{L}])создает/u.test(t)) return true;
    return /отсутству|не\s+существу|нет\s+в\s+дереве|пока\s+нет/u.test(t);
  });
}

/**
 * Слова, которые выглядят путями и путями не являются: «н/п» проходит любой фильтр со
 * слэшем, «т.е.» — любой фильтр с точкой.
 */
const PROSE_LOOKING_LIKE_PATH = new Set(['н/п', 'н/д', 'т.е.', 'т.д.', 'т.п.', 'и/или', 'и/или.']);

/**
 * Адрес файловой системы, названный в ячейке отчёта, — или `null`, если ячейка прозаическая.
 *
 * Одна функция на ОБА прохода (карта кодовой базы и «Опоры осей»). Раньше фильтр был
 * выписан дважды, копии уже разошлись (исключение узнанной шапки жило только в одной), и
 * оба несли один и тот же дефект: первый токен прозы принимался за путь. Живой отчёт со
 * строкой «н/п — своего механизма нет» объявлялся называющим несуществующий адрес, и
 * страж этапа 2 краснил ЧЕСТНЫЙ отчёт советом написать то, что там уже написано (ревью).
 *
 * Хвостовая пунктуация снимается: в перечислении «src/a.ts, src/b.ts» первым токеном
 * шла «src/a.ts,» — с запятой, которой на диске нет.
 */
function pathCandidate(raw: string): string | null {
  const rel = (raw.split(/\s/)[0] ?? '')
    .replace(/[),;»"'`]+$/u, '')
    .replace(/[.,]+$/u, '')
    .replace(/:[^/]*$/, '');
  if (rel === '' || rel.includes('‹')) return null;
  if (PROSE_LOOKING_LIKE_PATH.has(rel.toLowerCase())) return null;
  const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(rel);
  const hasSep = /[/\\]/.test(rel);
  // Ячейка без разделителя пути и без расширения — словесное описание, не путь:
  // живой прогон ta-13 ложно падал на таких.
  if (!hasExt && !hasSep) return null;
  // Кириллица без расширения — проза со слэшем («н/п», «и/или»), а не адрес. Файл с
  // кириллическим именем узнаётся по расширению и сюда не попадает.
  if (!hasExt && /[а-яё]/i.test(rel)) return null;
  return rel;
}

/**
 * Та же проверка, что и предусловие ниже, но отдельной функцией — её зовут ДВОЕ.
 *
 * Страж завершения этапа 2 (`Run.runStage`) даёт модели поправить карту в СВОЁМ ходу, а
 * предусловие этапа 3 остаётся сетью безопасности на случай, когда этап 2 прошёл в другой
 * сессии или страж был обойдён. Пока проверка стояла только предусловием, она срабатывала
 * ПОСЛЕ закрытия этапа 2 — модель уже ушла, и виток умирал на входе в этап 3, хотя чинить
 * там было нечем и некому (живой прогон r32).
 */
export function explorationPathProblem(c: StageContext): string | null {
  {
    {
      if (isSmallContour(c)) return null;
      const report = readArtifact(c.paths.explorationReport);
      if (!report.exists) return null; // отсутствие отчёта ловит соседнее предусловие
      const missing: string[] = [];
      // Границы секции карты — по h2 ВРУЧНУЮ, а не по `table.section`: parseTables
      // сбрасывает секцию на заголовке любого уровня, и «### Ключевые файлы» внутри карты
      // выводил бы свои таблицы из-под проверки (fail-open, пойман ревью-3); старый
      // построчный код `/^##\s/` подзаголовки h3 сквозь себя пропускал — это сохранено.
      // Признак секции — «кодовая база» или «карта кода», а не голое «карта»: одно слово
      // матчило «## Карта рисков» и «## Дорожная карта» как карту кодовой базы — ложный
      // красный на честном отчёте. Но и требовать оба слова вместе нельзя: модель,
      // переименовавшая заголовок в «## Кодовая база», выводила таблицу сочинённых путей
      // из-под проверки вовсе (code-review-all, 2026-09-14).
      // «Кодовая база» — в начале заголовка (после эмодзи и знаков) либо сразу после слова
      // «карта»: без этого «## Карта кодов ошибок» и «## Что уже есть в кодовой базе»
      // считались второй картой, и честный отчёт получал красный «несколько секций».
      // Окончания перечислены явно: `\b` по кириллице не работает.
      const mapRanges = h2SectionRanges(
        report.text,
        /^[^\p{L}]*кодов(ая|ой)\s+баз|карта\s+кодов(ая|ой)\s+баз|(^|[^\p{L}])карта\s+кода(\s|$)/iu,
      );
      // Несколько таких секций, и хотя бы одна БЕЗ таблицы — модель не заполнила
      // поле-образец, а стёрла структуру и завела свой заголовок с прозой. Построчная
      // проверка ниже смотрит только найденные таблицы, и секция без них проходит её молча.
      // Живой замер серии v4, `qwencoder`/`silent-contract`, 2026-09-14: исходный «## Карта
      // кодовой базы» с одной легендой и рядом «## 🗺️ Карта кодовой базы (Что сейчас / Что
      // меняем)» с прозой. Две секции, обе с таблицами («… — ключевые файлы»), — честная
      // разбивка, и она проверяется построчно, а не краснит целиком.
      if (
        mapRanges.length > 1 &&
        mapRanges.some((r) => parseTables(report.text.slice(r.start, r.end)).length === 0)
      ) {
        return (
          'в отчёте разведки несколько секций «Карта кодовой базы» — похоже, структура ' +
          'бланка подменена (заголовок продублирован, а исходная таблица брошена). Верни ' +
          'ОДНУ секцию с этим заголовком и заполни именно её таблицу, не пиши текст рядом'
        );
      }
      for (const range of mapRanges) {
        for (const table of parseTables(report.text.slice(range.start, range.end))) {
          // Шапка проверяется наравне со строками: карта без строки-шапки (пишет модель)
          // иначе теряла бы первую строку данных — parseTables объявил бы её шапкой.
          // Исключение — шапка, УЗНАННАЯ по имени ПЕРВОЙ колонки: «Путь/файл» содержит
          // `/` и без этого читалась бы сочинённым путём (ложный красный, ревью-4).
          // Только первая ячейка и только слова колонки путей: `.some` по всем ячейкам
          // объявлял шапкой первую строку данных с «файл конфигурации…»/«что меняем…»
          // в свободном тексте — её путь выпадал из проверки (fail-open, ревью-5).
          // Настоящей шапке без `/` и `.` в первой ячейке («Модуль», «Где») узнавание
          // не нужно: её и так пропустит фильтр словесных описаний ниже.
          const namedHeader = /^(файл|путь)/i.test((table.header[0] ?? '').trim());
          for (const row of namedHeader ? table.rows : [table.header, ...table.rows]) {
            const first = (row[0] ?? '').replace(/`/g, '').trim();
            if (first === '') continue;
            // Путь, объявленный БУДУЩИМ, законно не существует.
            //
            // Признак ищется по ВСЕЙ строке, а не в первых двух ячейках: живой прогон
            // (r32) убил виток на честном отчёте — модель написала
            // `| src/oversize.ts | Файл отсутствует | Создание нового модуля… |`, то есть
            // сказала правду дважды, и обе формулировки прошли мимо словаря: «отсутствует»
            // в нём не было, а «нового» стояло в третьей ячейке.
            //
            // Цена расширения названа честно: чем шире словарь, тем легче сочинённому пути
            // проскочить с пометкой «новый». Но защита пробивалась одним словом и прежде —
            // меняется размер дыры, а не её наличие; ложные же срабатывания убивали виток
            // ПОСЛЕ закрытия этапа, когда чинить уже некому. «нов» по-прежнему только как
            // начало слова: подстрока ловила «осНОВной» и «обНОВление».
            if (declaredAsNew(row)) continue;
            // Адреса кода в отчётах — в форме `путь:метод`; существование проверяем только у пути.
            const rel = pathCandidate(first);
            if (rel === null) continue;
            // Каталог — законный житель карты («server/src/exec/ — исполнители этапов»),
            // а `artifactExists` требует файла: честный отчёт объявлялся бы сочинённым.
            if (!pathExistsAny(`${c.paths.projectRoot}/${rel}`)) missing.push(rel);
          }
        }
      }
      if (missing.length > 0) {
        return (
          `карта кодовой базы в отчёте разведки называет несуществующие пути: ${missing.join(', ')} — ` +
          `отчёт сочинён, а не прочитан из кода. Разведку нужно переделать по реальным файлам`
        );
      }

      // «Опоры осей» — та же фактичность, но адрес стоит во ВТОРОЙ колонке («Механизм
      // проекта»), а не в первой, поэтому общий проход выше его не видит. Цена сочинённого
      // адреса здесь выше, чем в карте: по нему этап 4 объявляет ось закрытой механизмом,
      // которого нет, и решение человека подменяется ссылкой в пустоту.
      const invented: string[] = [];
      for (const range of h2SectionRanges(report.text, /опоры осей/i)) {
        for (const table of parseTables(report.text.slice(range.start, range.end))) {
          const col = columnIndex(table.header, 'механизм');
          for (const row of [table.header, ...table.rows]) {
            const cell = (row[col >= 0 ? col : 1] ?? '').replace(/`/g, '').trim();
            if (cell === '' || cell.includes('‹')) continue;
            if (declaredAsNew(row)) continue;
            // «нет механизма» и прочая проза путём не являются — тем же фильтром, что в
            // карте, и ИМЕННО тем же: две копии этого правила уже успели разойтись.
            const rel = pathCandidate(cell);
            if (rel === null) continue;
            if (!pathExistsAny(`${c.paths.projectRoot}/${rel}`)) invented.push(rel);
          }
        }
      }
      if (invented.length > 0) {
        return (
          `«Опоры осей» в отчёте разведки называют несуществующие адреса: ${invented.join(', ')} — ` +
          `механизм, которого нет, закрыть ось не может. Либо назови настоящий адрес, либо ` +
          `напиши «нет механизма»: это законный ответ и такое же знание`
        );
      }
      return null;
    }
  }
}

/**
 * Пути из карты кодовой базы отчёта разведки существуют в дереве — фактичность конструкцией.
 *
 * Живой прогон ta-13: разведчик-модель СОЧИНИЛА отчёт, не открыв ни файла, — Flask вместо
 * FastAPI и несуществующие пути (`frontend/components/undo-toast.jsx`), а «заполненность»
 * гейт прошла: плейсхолдеров-то не осталось. Существование пути — самый дешёвый детектор
 * сочинённой карты. Строка с пометкой «нов…» (новый файл/модуль) законно указывает на
 * ещё не существующий путь и пропускается.
 */
export function explorationPathsExist(): Precondition {
  return {
    describe: 'пути из карты кодовой базы существуют в дереве',
    artifact: (c) => c.paths.explorationReport,
    check: explorationPathProblem,
  };
}

export const exploreStage: StageDef = {
  id: 'explore',
  skill: 'sdlc-explore',
  title: 'Разведка',
  tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Task', 'AskHuman', 'FinalizeArtifact', 'FillField'],
  // Второй агент выводит приёмочный лист вслепую: агент, прочитавший авторский лист,
  // выведет тот же самый, и сверка станет декорацией.
  subagents: ['sdlc-claims'],
  produces: (c) => [c.paths.explorationReport],
  requires: [
    filledExceptTouchSection('задача заполнена без плейсхолдеров', (c) => c.paths.intent),
    exists('проверка готовности пройдена (прогон 1)', (c) => c.paths.readiness),
    claimsMinimum(),
  ],
  protectedArtifacts: (c) => [`${SDLC_DIR}/gates.md`, relOf(c, c.paths.plan)],
  humanGate: { artifact: 'exploration', label: DECISION.checklistComplete },
  skipIf: (c) =>
    isSmallContour(c)
      ? 'мелкий контур: разведка точечная на этапе 5, отчёт не пишется'
      : null,
};

/**
 * Исполняется ли этап 2 конвейером рантайма (`ExploreExecutor`, `ModelDef.exploreFill`).
 * Только flow `loop`: у `sdk` своего цикла нет, и ручка там игнорируется с предупреждением
 * в `executorFor` — тем же способом, что `stepFill`.
 */
export function usesExploreFill(route: ResolvedRoute): boolean {
  return route.flow === 'loop' && route.exploreFill;
}

/** Строка набора «Независимый вывод claims вторым агентом»; `null` — строки нет. */
function claimsGateRow(gates: GatesFile | null): GateRow | null {
  if (gates === null) return null;
  return gates.rows.find((r) => gateKey(r.name) === gateKey('Независимый вывод claims вторым агентом')) ?? null;
}

/** Состояние гейта «Заполненность артефактов» для отчёта разведки. */
function fillednessGateState(gates: GatesFile | null): 'enabled' | 'debt' | 'absent' {
  const row = gates?.rows.find((r) => gateKey(r.name) === gateKey('Заполненность артефактов'));
  if (row === undefined) return 'absent';
  return row.enabled ? 'enabled' : 'debt';
}

/** Строки секции «Чего не делаем» задачи — адресат вердикта «вне scope» при сверке листов. */
function notDoingLines(intentText: string): string[] {
  return h2SectionRanges(intentText, /^чего не делаем$/i)
    .flatMap((r) => intentText.slice(r.start, r.end).split(/\r?\n/))
    .filter((l) => /^\s*[-*+]\s+/.test(l) && !l.includes('‹'))
    .map((l) => l.trim());
}

/**
 * Индекс проекта для разведки (`explore/*`) — по задаче на диске, с кэшем
 * (`ExploreState.indexCache`). Экосистема приходит от вызывающего тем же `describeBuild`, что
 * у гейтов и блока `ecosystem`: второй детект здесь разошёлся бы с первым.
 */
export function exploreIndexFor(
  host: StageHost,
  ecosystem: readonly EcosystemLine[],
): { index: ExploreIndex; kw: Keywords; built: BuiltView } {
  const intent = readArtifact(host.paths.intent);
  const intentText = intent.exists ? intent.text : '';
  const axesEnabled = host.axesEnabled();
  const key = `${axesEnabled ? 'axes' : 'no-axes'}\n${ecosystem.map((e) => `${e.dir}|${e.build ?? ''}|${e.test ?? ''}`).join(';')}\n${intentText}`;
  if (host.exploreState.indexCache !== null && host.exploreState.indexCache.key === key) return host.exploreState.indexCache;
  const index = readTree(host.projectRoot);
  const kw = intentKeywords(intentText);
  const built = buildView(index, ecosystem, kw, axesEnabled);
  host.exploreState.indexCache = { key, index, kw, built };
  return host.exploreState.indexCache;
}

/**
 * Слепой вывод приёмочного листа рантаймом — шаг конвейера `exploreFill`, идущий ДО хода
 * модели (тем же порядком, что `runReviewerDirectly` на этапе 6). Слепота — входом:
 * агенту уходят четыре секции задачи, индекс и карточки кандидатов, без инструментов
 * (`run/claimsBlind.ts`). Итог кладётся в `ExploreState.claims`, исполнитель забирает его оттуда.
 */
export async function runClaimsBlind(host: StageHost, route: ResolvedRoute, ecosystem: readonly EcosystemLine[]): Promise<void> {
  host.exploreState.claims = { result: null, skipReason: null };
  const warn = (message: string): void => host.emit({ type: 'warning', runId: host.id, stage: 'explore', message });
  const row = claimsGateRow(host.gatesFile());
  if (row !== null && !row.enabled) {
    host.exploreState.claims.skipReason = 'гейт «Независимый вывод claims вторым агентом» в долге';
    return;
  }
  if (row === null) {
    warn('строки «Независимый вывод claims вторым агентом» в наборе нет — второй агент запущен по умолчанию методологии; добавь строку в .sdlc/gates.md');
  }
  const def = loadSubagent(host.runner().agentsDir, 'sdlc-claims');
  if (def === null) {
    host.exploreState.claims.skipReason = `определение субагента sdlc-claims не найдено в ${host.runner().agentsDir}`;
    warn(`слепой вывод листа не запущен: ${host.exploreState.claims.skipReason}`);
    return;
  }
  const intent = readArtifact(host.paths.intent);
  const sections = intent.exists ? intentSectionsForBlind(intent.text) : null;
  if (sections === null) {
    host.exploreState.claims.skipReason = 'в задаче нет секций «Коротко»/«Что делаем» — слепой вывод не с чего';
    warn(`слепой вывод листа не запущен: ${host.exploreState.claims.skipReason}`);
    return;
  }
  const { built } = exploreIndexFor(host, ecosystem);
  const limits = host.limits();
  const cardBudget = Math.min(limits.maxToolResultBytes, limits.localMaxToolResultBytes);
  const perCard = cardBudgetPerFile(cardBudget, built.ranked.length);
  const result = await deriveClaimsBlind({
    provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, host.trace('explore', 'claimsBlind')),
    model: route.model,
    params: route.params,
    system: def.prompt,
    sections,
    indexBlock: renderIndexBlock(built.view, INDEX_BLOCK_BYTES.loop),
    sources: packCards(built.ranked.map((r) => fileCard(r.file, perCard)), cardBudget),
    signal: host.signal(),
    onProgress: warn,
    onUsage: (usage) => host.accountOffPathUsage('explore', usage, route.providerDef.currency),
  });
  // `requestError` — запрос не состоялся (сеть, таймаут), а не «субагент честно вернул
  // пустой лист»: без разделения отчёт писал бы утверждение о проведённом сравнении,
  // которого не было (ревью code-review-all, 2026-09-11).
  host.exploreState.claims = {
    result,
    skipReason:
      result.claims.length === 0
        ? result.requestError !== null
          ? `запрос к субагенту не удался: ${result.requestError}`
          : 'субагент вернул пустой лист — второго измерения не было'
        : null,
  };
  if (result.envFailure !== null) throw new ProviderEnvError(result.envFailure);
}

/**
 * Этап 2 конвейером рантайма (`ModelDef.exploreFill`): индекс, карточки, закрытые
 * вопросы, запись через гейт — `exec/ExploreExecutor.ts`. Слепой лист уже посчитан
 * (`runClaimsBlind`) и лежит в `ExploreState.claims`.
 */
export function exploreFillExecutor(host: StageHost, route: ResolvedRoute): ExploreExecutor {
  const stage = 'explore';
  const limits = host.limits();
  const ecosystem = host.ecosystemFor(stage);
  const { index, built } = exploreIndexFor(host, ecosystem);
  const intent = readArtifact(host.paths.intent);
  const intentText = intent.exists ? intent.text : '';
  const claims: AuthorClaim[] = [...host.intentClaimLines(intentText)].map(([id, line]) => ({ id, text: claimTextCell(line) }));
  host.emit({
    type: 'warning',
    runId: host.id,
    stage,
    message:
      `режим разведки конвейером: кандидатов ${built.ranked.length} (${built.ranked.map((r) => r.file.path).join(', ') || 'нет'}), ` +
      `переиспользования ${built.reuse.length}; AskHuman и Task в режиме нет — вопросы уходят в «Всплывшие вопросы», ` +
      'решение о полноте листа остаётся полем человека',
  });
  return new ExploreExecutor({
    provider: createProvider(route.provider, route.providerDef, limits.chatTimeoutMs, host.trace(stage, 'explore')),
    params: route.params,
    currency: route.providerDef.currency ?? 'USD',
    ...(route.contextWindow === undefined ? {} : { contextWindow: route.contextWindow }),
    maxResultBytes: Math.min(limits.maxToolResultBytes, limits.localMaxToolResultBytes),
    readRangeRequiredAboveBytes: limits.readRangeRequiredAboveBytes,
    bashTimeoutMs: limits.gateTimeoutMs,
    index,
    built,
    ecosystem,
    intent: {
      path: host.paths.intent,
      readinessPath: host.paths.readiness,
      title: titleFromIntent(intentText) ?? host.slug,
      brief: briefFromIntent(intentText),
      claims,
      notDoing: notDoingLines(intentText),
    },
    reportPath: host.paths.explorationReport,
    claims: host.exploreState.claims.result,
    claimsSkipReason: host.exploreState.claims.skipReason,
    axesEnabled: host.axesEnabled(),
    fillednessGate: fillednessGateState(host.gatesFile()),
    edgeExample: edgeExampleLines(host.runner().methodologyDir),
    cardBudgetBytes: Math.min(limits.maxToolResultBytes, limits.localMaxToolResultBytes),
  });
}

export const exploreModule: StageModule = {
  def: exploreStage,
  formFillExecutor: false,
  leanDocTools: false,
  mechanicalJobs: (host) => [{ path: host.paths.explorationReport, fill: async (t) => autofillTitle(t, host.slug) }],
  checksBranchOnEntry: false,
  begin: (host) => ({
    // Кэш индекса разведки ключуется по тексту задачи и экосистеме, а не по состоянию
    // дерева проекта: тот же ключ мог совпасть у ДВУХ разных попыток этапа (тот же intent,
    // тот же стек), пока между ними в целевом проекте появился/изменился файл — и второй
    // проход тихо получал бы дерево первого. Сброс НА ВХОДЕ в этап — тот же приём, что у
    // `lastPreflightBlockers` этапа 6; в пределах одного прохода `exploreIndexFor` по-прежнему
    // считает дерево один раз на 2–3 вызова (ревью code-review-all, 2026-09-11).
    resetOnEnter: () => {
      host.exploreState.indexCache = null;
    },
  }),
};

/** Состояние этапа 2 между вызовами. Владелец — виток (`Run.state.explore`). */
export class ExploreState {
  /**
   * Индекс проекта для этапа 2 — считается лениво и кэшируется по ключу (текст задачи +
   * включённость гейта осей): `preparePrompt` зовётся и из интерфейса на каждый показ
   * промпта, а обход дерева с чтением файлов на каждый показ — лишняя работа и лишний I/O.
   * Тот же снимок уходит и в блок промпта, и в карточки конвейера `exploreFill`: список
   * для оператора и список для модели обязаны совпадать.
   */
  indexCache: { key: string; index: ExploreIndex; kw: Keywords; built: BuiltView } | null = null;

  /**
   * Итог слепого вывода листа (`runClaimsBlind`) для конвейера `exploreFill` — считается в
   * `runStage` ДО создания исполнителя (запуск асинхронный, `executorFor` — нет).
   * `result: null` — не запускался, причина в `skipReason`.
   */
  claims: { result: BlindClaimsResult | null; skipReason: string | null } = { result: null, skipReason: null };
}
