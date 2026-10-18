/**
 * Запись, впервые проставляющая поле решения человека, — отдельная проверка гейта
 * одобрений, не политика: как и `symlink.ts`, требует чтения файла с диска.
 *
 * `destructive.ts` уже ловит ПОТЕРЮ поля решения через `Write`/`FillField` целиком (метка
 * исчезла из документа при перезаписи), но не ловит его ПОЯВЛЕНИЕ: `Edit`, меняющий только
 * значение уже существующей метки («‹имя› · ‹дата›» → «Иван Петров · 2026-09-18»), метку не
 * трогает — `lostDecisionLabels` его не видит, а точечная правка вообще выведена из-под
 * `destructiveOverwrite` («не про Edit: точечная замена фрагмента не может потерять файл
 * целиком» — верно для доли строк, но не для разметки одной метки). Поле решения при этом
 * не теряется — оно ФАБРИКУЕТСЯ, и это другой класс потери: «Приёмка», «Одобрение»,
 * «Подтвердил», «Кто утвердил» решает оператор через свой путь (`setDecision`, минуя
 * политику вовсе), а не модель инструментом `Edit`/`Write`. Третий класс, тем же приёмом
 * пойманный ниже: `Edit`, стирающий саму жирную разметку метки заодно со значением
 * («- **Подтвердил:** ‹имя› · ‹дата›» → «- Подтвердил: X · Y») — файл при этом не теряет
 * ни строки, `destructiveOverwrite` молчит по конструкции, а `fabricatedLabel` слеп: без
 * узнаваемой метки в `after` ему не с чем сравнивать `before`. Живой прогон поймал это
 * (`ollama:gpt-oss-20b-agent`, rename-field, 2026-09-24): chunk закрылся `ok`, а решение
 * оказалось нечитаемым только на следующем предусловии.
 *
 * Проверка — ТОЛЬКО по результату, который можно предсказать дословным сопоставлением:
 * не найден `old_string` (в том числе фрагмент, требующий мягкого поиска `editMatch.ts`) —
 * решение оставляется исполнителю, гейт не гадает. Направление ошибки здесь другое, чем у
 * запрета: лучше пропустить редкий случай, который сам не смог предсказать, чем завести
 * второе место, где угадывается результат применения правки (см. `CLAUDE.md` про единую
 * форму вызова у обоих флоу).
 *
 * Сравнение «до/после» — по МНОЖЕСТВУ конкретных (не-плейсхолдерных) значений метки, а не
 * по позиционной паре «i-е вхождение до» ↔ «i-е вхождение после» и не по классификации
 * состояния одной пары. Два урока ревью, оба воспроизведены живым прогоном кода:
 *  - позиционное сравнение плюс требование «число вхождений не изменилось» пропускает
 *    фабрикацию, если та же запись `Write` заодно добавляет новую (легитимно пустую)
 *    запись — счётчик вхождений меняется, и вся проверка выключается целиком;
 *  - сравнение по СОСТОЯНИЮ (`missing/placeholder` → `granted/declined`) не ловит отмену
 *    уже принятого отказа (`declined` → `granted`) — оба состояния «isSet», переход между
 *    ними не считается переходом «из ничего».
 * Множественная разность (см. `fabricatedLabel`) снимает оба класса разом и попутно не
 * даёт ложных срабатываний на переупорядочении существующих записей.
 */

import type { EditOp, NormalizedCall, PolicyContext } from '@sdlc-runner/shared';

import {
  applyExactReplace,
  decisionColumnValues,
  decisionLabelsIn,
  decisionLineIndexes,
  decisionStateAt,
  hasDecisionColumns,
  lineStarts,
  readArtifact,
} from '../artifacts/artifact.ts';
import type { DecisionState } from '../artifacts/artifact.ts';
import { hasOverwriteSection, overwriteConfirmations } from '../artifacts/overwriteConfirmations.ts';
import { adaptEol, findLooseRange } from '../exec/editMatch.ts';
import { writeTargetPaths } from '../policy/index.ts';
import { resolveUserPath } from '../policy/paths.ts';

/**
 * Применяет `edits` тем же правилом, что инструмент `Edit` (`exec/tools/index.ts`):
 * дословно, а при промахе — мягким поиском с точностью до пробельных промежутков
 * (`findLooseRange`). `null` — фрагмент не нашёлся ни так, ни так (инструмент тоже
 * откажет). Прежде здесь был только дословный путь: правка поля «Утвердил» с чуть иными
 * пробелами в `old_string` проходила гейт непроверенной, а инструмент её применял
 * (code-review-all 2026-09-23).
 */
function applyEditsExact(text: string, edits: readonly EditOp[]): string | null {
  let out = text;
  for (const raw of edits) {
    const e = adaptEol(out, raw);
    if (out.includes(e.oldStr)) {
      out = applyExactReplace(out, e.oldStr, e.newStr, e.replaceAll);
      continue;
    }
    const loose = e.replaceAll ? 'none' : findLooseRange(out, e.oldStr);
    if (typeof loose !== 'object') return null;
    out = out.slice(0, loose.start) + e.newStr + out.slice(loose.end);
  }
  return out;
}

/** Сырое значение состояния — пусто у `missing`, дословный текст у всех остальных состояний. */
function rawOf(s: DecisionState): string {
  return s.state === 'missing' ? '' : s.raw.trim();
}

/** Есть ли у состояния КОНКРЕТНОЕ (не плейсхолдер, не пусто) содержимое — решение принято, каким бы оно ни было. */
function isConcrete(s: DecisionState): boolean {
  return s.state === 'granted' || s.state === 'declined';
}

/**
 * Конкретные (не-плейсхолдерные) значения метки во всём документе, по порядку вхождений.
 */
function concreteValues(text: string, label: string): string[] {
  const lines = text.split('\n');
  const starts = lineStarts(text);
  const out: string[] = [];
  for (const i of decisionLineIndexes(lines, label)) {
    const state = decisionStateAt(text, lines, starts, i, label);
    if (isConcrete(state)) out.push(rawOf(state));
  }
  return out;
}

/**
 * Метка, у которой в `after` появилось конкретное значение, которого не было среди
 * конкретных значений `before` — множественная разность (мультимножество), не позиционная
 * пара. Сравнение по ТЕКСТУ значения, не по числу вхождений и не по классу состояния:
 *  - плейсхолдер → значение на ТОМ ЖЕ вхождении: новое значение не входит в `before` — ловится;
 *  - `declined` → `granted` (отмена отказа): новый текст не совпадает со старым `declined`-текстом — ловится;
 *  - одновременное добавление новой (пустой) записи и фабрикация существующей: у новой
 *    записи значение не конкретно (не входит в множества вовсе), фабрикация существующей
 *    всё равно даёт лишнее конкретное значение в `after` — ловится, число вхождений расти
 *    может свободно;
 *  - переупорядочение существующих конкретных записей без изменения текста: те же значения
 *    остаются в обоих множествах — НЕ ловится (не фабрикация).
 */
function fabricatedLabel(before: string, after: string, label: string): boolean {
  const beforeValues = concreteValues(before, label);
  const afterValues = concreteValues(after, label);
  if (beforeValues.length === 0 && afterValues.length === 0) return false;
  const remaining = [...afterValues];
  for (const v of beforeValues) {
    const at = remaining.indexOf(v);
    if (at >= 0) remaining.splice(at, 1);
  }
  return remaining.length > 0;
}

/**
 * Bash пишет в файл дословно предсказуемым способом только для `>`/`>>`/`tee`-редиректов
 * (`policy/shellRedirects.ts`), а произвольную команду (`sed -i`, `cp`, пайпы) статически
 * предсказать нельзя — сравнение «до/после», которым живёт `fabricatedLabel`, здесь не
 * применимо. Вместо того чтобы гадать по содержимому, действуем fail-closed тем же приёмом,
 * что уже применяет `symlinkEscape` рядом: если цель записи (та же `writeTargetPaths`, что
 * проверяет `checkAll` на побег через symlink) — файл, УЖЕ несущий хоть одну метку решения
 * человека, запись отклоняется целиком, не дожидаясь фабрикации. `Edit`/`Write` в этот файл
 * по-прежнему разрешены и проверяются точно (ревью code-review-all, 2026-09-19: до этой
 * правки `call.kind === 'bash'` пропускался с первой строки функции — bash-редирект в
 * `handoff.md` подставлял «Кто утвердил» мимо единственной защиты от фабрикации).
 */
function bashDecisionWriteProblem(call: Extract<NormalizedCall, { kind: 'bash' }>, ctx: PolicyContext): string | null {
  for (const path of writeTargetPaths(call, ctx) ?? []) {
    const abs = resolveUserPath(ctx.projectRoot, path);
    const state = readArtifact(abs);
    if (!state.exists) continue;
    if (decisionLabelsIn(state.text).length > 0 || (isArtifactPath(ctx, path) && (hasDecisionColumns(state.text) || hasOverwriteSection(state.text)))) {
      return (
        `запись в «${path}» через Bash отклонена: файл несёт поле решения человека, а ` +
        `дословно предсказать результат произвольной команды нельзя — используй Edit/Write, ` +
        `там фабрикация проверяется точно`
      );
    }
  }
  return null;
}

/**
 * `null` — запись не трогает ни одно поле решения человека, либо результат нельзя
 * предсказать дословно (гейт не решает за исполнителя). Строка — причина отказа.
 */
export function decisionFabricationProblem(call: NormalizedCall, ctx: PolicyContext): string | null {
  if (call.kind === 'bash') return bashDecisionWriteProblem(call, ctx);
  if (call.kind !== 'edit' && call.kind !== 'write') return null;
  const abs = resolveUserPath(ctx.projectRoot, call.path);
  const state = readArtifact(abs);
  if (!state.exists) return null;
  const before = state.text;
  const labels = decisionLabelsIn(before);
  // Подписные колонки и строки подтверждения перезаписи — только в АРТЕФАКТАХ витка и наборе
  // гейтов: в файлах продукта таблица `| Кто | Что |` — содержимое, а не решение (ревью).
  const artifact = isArtifactPath(ctx, call.path);
  const columns = artifact && hasDecisionColumns(before);
  const overwrites = artifact && hasOverwriteSection(before);
  if (labels.length === 0 && !columns && !overwrites) return null;

  const after = call.kind === 'write' ? call.content : applyEditsExact(before, call.edits);
  if (after === null || after === before) return null;

  // Точечная правка может снять жирную метку поля решения, не потеряв файл целиком —
  // `destructive.ts` эту потерю по замыслу не видит («не про Edit: точечная замена
  // фрагмента не может потерять файл целиком»), а `fabricatedLabel` ниже сравнивает
  // КОНКРЕТНЫЕ значения ПОД той же меткой и потому тоже слеп: без метки после правки ему
  // не с чем сравнивать. Живой прогон (ollama:gpt-oss-20b-agent, rename-field,
  // 2026-09-24): Edit заменил всю строку «- **Подтвердил:** ‹имя› · ‹дата› / …» на
  // «-  Подтвердил: BENCHMARK · 2026-09-24» — метка потеряла разметку, значение стало
  // решённым на вид, оба гейта промолчали, chunk закрылся `ok`, и только предусловие
  // следующего шага заметило «поля нет». Ловим здесь же, пока есть и `before`, и `after`.
  if (call.kind === 'edit') {
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const lostLabel = labels.find((label) => decisionLineIndexes(afterLines, label).length < decisionLineIndexes(beforeLines, label).length);
    if (lostLabel !== undefined) {
      return (
        `поле решения человека «${lostLabel}» потеряло разметку метки при правке — значение стало ` +
        `похоже на решённое, а решает его только оператор (через своё утверждение), не модель ` +
        `инструментом записи`
      );
    }
  }

  // Подтверждение перезаписи (`## Перезапись файлов`, «подтвердил имя · дата») — решение
  // человека списком, а не полем: строка с именем, которой не было, — та же фабрикация.
  if (overwrites) {
    const was = new Set(overwriteConfirmations(before).map((c) => `${c.path}|${c.signedBy}`));
    const fresh = overwriteConfirmations(after).find((c) => !was.has(`${c.path}|${c.signedBy}`));
    if (fresh !== undefined) {
      return (
        `подтверждение перезаписи «${fresh.path} — подтвердил ${fresh.signedBy}» в журнале chunk'а — решение ` +
        `человека: строку с именем пишет только оператор, не модель инструментом записи`
      );
    }
  }

  const fabricated = labels.find((label) => fabricatedLabel(before, after, label));
  if (fabricated !== undefined) {
    return (
      `поле решения человека «${fabricated}» — заполняет только оператор (через своё утверждение), ` +
      `не модель инструментом записи`
    );
  }
  // Подписные колонки таблиц («Утвердил (человек)», «Кто утвердил», «Подтвердил») — то же
  // поле решения, только колонкой: имя, появившееся в ячейке после записи модели, снимало
  // бы `⏭` гейта или закрывало долг набора её же рукой. Множественная разность — тем же
  // приёмом, что у меток: переупорядочение уже подписанных строк не ловится.
  if (columns) {
    const cell = fabricatedCell(before, after);
    if (cell !== null) {
      return (
        `подписная колонка таблицы «${cell}» — поле решения человека: ячейку заполняет только оператор, ` +
        `не модель инструментом записи (пустая/‹…›/н/п ячейка остаётся пустой)`
      );
    }
  }
  return null;
}

/** Путь — артефакт витка (`.sdlc/<slug>/…`) либо набор гейтов проекта (`.sdlc/gates.md`). */
function isArtifactPath(ctx: PolicyContext, path: string): boolean {
  const rel = path.replace(/\\/g, '/').toLowerCase();
  const dir = ctx.sdlcDir.replace(/\\/g, '/').toLowerCase();
  return rel.includes(`${dir}/`) || rel.endsWith('.sdlc/gates.md') || rel.startsWith(`${dir}/`);
}

/** Значение подписной колонки, появившееся в `after`, которого не было в `before`; `null` — нет. */
function fabricatedCell(before: string, after: string): string | null {
  const remaining = decisionColumnValues(after);
  for (const v of decisionColumnValues(before)) {
    const at = remaining.indexOf(v);
    if (at >= 0) remaining.splice(at, 1);
  }
  return remaining[0] ?? null;
}
