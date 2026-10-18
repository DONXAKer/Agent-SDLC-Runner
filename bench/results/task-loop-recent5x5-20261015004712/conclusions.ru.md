# Выводы: 5 моделей × 5 задач

Каталог: `bench/results/task-loop-recent5x5-20261015004712`. Arm: local, repeats: 1.

## Матрица (автоприёмка)

| Модель | range-union | option-overlay | csv-cell | cent-split | page-window | Итого |
|---|---|---|---|---|---|---:|
| qwen3.8-27b-iq4-gpumax | ok | ok | ok | ok | ok | 5/5 |
| gpt-oss-20b-ctx32k | failed/h:fail | ok | ok | ok | ok | 4/5 |
| mellum2-12b-instruct-q6 | needs_input/h:fail | failed | ready_for_review/falseSuccess | ok | ok | 2/5 |
| devstral-small-2 | budget_exhausted | budget_exhausted/h:fail | failed | ok | ok | 2/5 |
| ministral3-14b-instruct-ctx32k | failed/h:empty_tap | failed/h:empty_tap | ready_for_review/falseSuccess | budget_exhausted/h:empty_tap | failed/h:fail | 0/5 |

## Вывод по флоу

Короткий цикл `local` работоспособен: сильные модели стабильно доходят до автоприёмки; `option-overlay` после фиксов witness/`public-api` проходит у qwen и gpt-oss.

Классы, которые ещё портили приёмку в этой серии (закрыты кодом после прогона):

1. **AskHuman переспрашивает контракт** (mellum × range-union: поведение touching ranges) → runtime reject `contractRestatement`.
2. **Мета-AskHuman + fallback в asks** (mellum × csv-cell: «satisfy requirements?» при green) → runtime `metaReview`; после green банк не зовётся (`ignored_after_green`), `obligations.questions` принимает `runtime` / `ignored_after_green`.
3. **newTest: файл ≠ форма seed** (ministral × csv: `csvRow.test.js` при suite `.mjs`) → finishGuard требует совпадение расширения / `.test.` с seed.

Evidence по умолчанию не включать (серия v2: evidence не лучше local).

## Вывод по моделям

| Модель | Автоприёмка | Вердикт |
|---|---:|---|
| qwen3.8-27b-iq4-gpumax | 5/5 | Лучший кандидат короткого цикла на этом наборе |
| gpt-oss-20b-ctx32k | 4/5 | Сильный; один отказ — зацикливание Read на range-union |
| mellum2-12b-instruct-q6 | 2/5 | Ломалась на AskHuman/мета; код местами ок |
| devstral-small-2 | 2/5 | Часто budget / fail; не опора |
| ministral3-14b-instruct-ctx32k | 0/5 | Непригодна как исполнитель здесь (синтаксис, empty_tap, budget) |

Ограничения: одна повторность, без evidence-arm; ориентир для выбора модели, не статистика. Повторный замер — новым каталогом после смены `sourceHash`.
