# Находка: repair → патологический алгоритм → timeout hidden

Задача: `cent-split`, повтор 1. Сравнение: [local-cent-split-1](local-cent-split-1/) (accept, hidden 2/2) vs [evidence-cent-split-1](evidence-cent-split-1/) (false success, hidden 0/0).

## Класс

**Исполнитель / короткий цикл:** после красной видимой проверки модель чинит реализацию до зелёного `check`, затем вводит алгоритм с патологической сложностью на законных больших входах. Видимые тесты ещё успевают завершиться; независимая скрытая оценка упирается в таймаут и не даёт ни одной строки TAP → приёмка отклоняется как `falseSuccess` с `hidden 0/0`, а не как обычный «упал кейс».

Это не «evidence доказал лучший контракт». На этой ячейке evidence **ухудшил** исход относительно local при тех же checks и лимитах.

## Хронология evidence-cent-split-1

| Шаг | Что произошло |
|---|---|
| 1 | Первая реализация: `base = total / count` (float) → `splitCents(10,3)` даёт равные доли без extras на ранние индексы. |
| 2 | Repair по видимому провалу: переход на `Math.floor` / `%` — мелкие кейсы зелёные. |
| 3 | Модель добавляет собственный стресс с большим `total` и ошибочно диагностирует «потерю precision» у `floor`/`%` (для safe integer в JS они корректны). |
| 4 | «Фикс»: `total >> 10` + while-уточнение базы. В JS `>>` — **Int32**; на больших safe integer стартовый `base` уходит в огромный минус, while крутит миллионы/миллиарды итераций. |
| 5 | Финальные visible/test зелёные (~1.5 с на большой кейс модели). Hidden гоняет в т.ч. `Number.MAX_SAFE_INTEGER` × count∈{1,2,7,31} → practically infinite loop → таймаут 60 с, TAP пуст. |

Метрики ячейки: 27 model requests, 5 repairs, 5 repeatedErrors, ~334 с active vs ~78 с / 6 requests / 0 repairs у local.

Финальный патологический фрагмент ([patch-files/src/shares.mjs](evidence-cent-split-1/patch-files/src/shares.mjs)):

```js
const q10 = Math.floor((total >> 10) / count);
let base = q10 * 1024;
while ((base + 1) * count <= total) base += 1;
while (base * count > total) base -= 1;
```

Рабочий local-вариант ([local-cent-split-1/patch-files/src/shares.mjs](local-cent-split-1/patch-files/src/shares.mjs)):

```js
const base = Math.floor(total / count);
const extra = total % count;
return Array.from({length: count}, (_, i) => base + (i < extra ? 1 : 0));
```

Сообщение оценки: «скрытые тесты не дали ни одной разобранной строки TAP — снято по таймауту 60000 мс». Таймаут оценки сработал правильно как отказ приёмки; это не артефакт «среда сломалась», а сигнал патологического кода.

## Почему evidence здесь вредил

Structured feedback и repair-петля по видимым ошибкам **поощряют** доведение до зелёного check. Они не штрафуют:

- ложную диагностику (precision, где её нет);
- рост сложности / latency на borderline-входах;
- собственные тесты модели, которые зеленеют быстрее скрытого набора.

`repeatedErrors=5` — повтор одного и того же assertion summary без смены стратегии (тест ↔ код ↔ «precision»), а не быстрый сход к простому `%`.

## Что не делать по этой находке

- Не ослаблять скрытую приёмку и не увеличивать её таймаут «чтобы 0/0 стало 2/2».
- Не добавлять task-specific ветку под `cent-split` / `>>` в production executor.
- Не включать evidence по умолчанию из этой одной ячейки.

## Mitigations (2026-10-14, без повторного прогона серии)

Общие, без task-specific веток под `cent-split`:

- `TaskLoopExecutor`: каждый registered check гоняется под `AbortSignal.timeout(bashTimeoutMs)` — зависшая проверка даёт FAIL/timeout, а не «вечное» ожидание.
- Эскалация при `repeatedErrors >= 3` в тексте check / structured `nextAction`; опциональный стоп `maxRepeatedErrors` (пилот: **5**).
- Системный промпт: простейший алгоритм, без speculative precision / bit tricks / unbounded loops.
- Бюджет latency vs baseline (`max(2s, 5×)`); fingerprint повторов FAIL checks; `maxUnchangedFailures: 3` в пилоте.
- Timeout registered check больше не `environmentError`.
- Visible witness: `splitCents(Number.MAX_SAFE_INTEGER, 2)` — патологический while не успеет объявить готовность.
- Suite/HTML: явный `hiddenOutcome` (timeout ≠ голый `0/0`); render после каждой ячейки.

Это не доказывает, что evidence стал лучше local; меняет условия следующей серии (`sourceHash`).

Связанные артефакты: [evidence-metrics.json](evidence-metrics.json) (строка cent-split/evidence), [conclusions.ru.md](conclusions.ru.md).
