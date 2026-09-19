/**
 * Запись, впервые проставляющая поле решения человека, — отдельная проверка гейта
 * одобрений, не политика: как и `symlink.ts`, требует чтения файла с диска.
 *
 * `destructive.ts` уже ловит ПОТЕРЮ поля решения (метка исчезла из документа при
 * перезаписи), но не ловит его ПОЯВЛЕНИЕ: `Edit`, меняющий только значение уже
 * существующей метки («‹имя› · ‹дата›» → «Иван Петров · 2026-09-18»), метку не трогает —
 * `lostDecisionLabels` его не видит, а точечная правка вообще выведена из-под
 * `destructiveOverwrite` («не про Edit: точечная замена фрагмента не может потерять файл
 * целиком»). Поле решения при этом не теряется — оно ФАБРИКУЕТСЯ, и это другой класс
 * потери: «Приёмка», «Одобрение», «Подтвердил», «Кто утвердил» решает оператор через свой
 * путь (`setDecision`, минуя политику вовсе), а не модель инструментом `Edit`/`Write`.
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
  decisionLabelsIn,
  decisionLineIndexes,
  decisionStateAt,
  lineStarts,
  readArtifact,
} from '../artifacts/artifact.ts';
import type { DecisionState } from '../artifacts/artifact.ts';
import { writeTargetPaths } from '../policy/index.ts';
import { resolveUserPath } from '../policy/paths.ts';

/** Применяет `edits` дословно. `null` — хоть один `old_string` не нашёлся точь-в-точь. */
function applyEditsExact(text: string, edits: readonly EditOp[]): string | null {
  let out = text;
  for (const e of edits) {
    if (!out.includes(e.oldStr)) return null;
    out = applyExactReplace(out, e.oldStr, e.newStr, e.replaceAll);
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
    if (decisionLabelsIn(state.text).length > 0) {
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
  if (labels.length === 0) return null;

  const after = call.kind === 'write' ? call.content : applyEditsExact(before, call.edits);
  if (after === null || after === before) return null;

  const fabricated = labels.find((label) => fabricatedLabel(before, after, label));
  return fabricated === undefined
    ? null
    : `поле решения человека «${fabricated}» — заполняет только оператор (через своё утверждение), ` +
        `не модель инструментом записи`;
}
