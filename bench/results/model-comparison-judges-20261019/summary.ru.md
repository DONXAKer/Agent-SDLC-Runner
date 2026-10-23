# Сравнение моделей и настроек

Статус: **completed**. Начало: 2026-10-19T20:10:50.025Z. Завершение: 2026-10-19T20:24:15.529Z.
GPU-бюджет: 140.25583333333333 минут; использовано 13.4.
Отпечаток исходников: `79e920d96db97a77edf9b82783b345ab090e5d6661437f2d69c3fd497284a9bd`. Старый пилот не возобновлялся.

## Исполнители: короткий скрининг

| Вариант | Статус | Проверки | GPU-размещение | Причина |
|---|---|---|---|---|


Успех скрининга не означает успех полного процесса. Пробы используют штатный provider и PREFLIGHT_CASES.

## Судьи: независимые типизированные решения

| Модель | Набор | Статус | Верно/валидно/всего | Ложное разрешение scope | Ложная блокировка scope | Неподтверждённые утверждения | Brier | ECE | P50/P95 валидных ответов, мс | Причина |
|---|---|---|---|---|---|---|---|---|---|
| nimble-installed | diagnostic | unavailable | — | — | — | — | — | — | — | Error: HTTP 400: {"error":"'nimble:latest' was downloaded in a format that is no longer supported. To re-download, run 'ollama pull nimble:latest'"} |
| intern2 | diagnostic | completed | 27/30/30 | 0 | 0 | 0 | 0.112 | 0.166 | 288/373 | — |
| intern4 | diagnostic | completed | 26/30/30 | 0 | 0 | 0 | 0.076 | 0.130 | 2675/3581 | — |
| standard3 | diagnostic | unavailable | — | — | — | — | — | — | — | Error: Author SGLang unavailable/failed to load; inspect standard3.engine.log |
| standard8 | diagnostic | unavailable | — | — | — | — | — | — | — | Error: Author SGLang unavailable/failed to load; inspect standard8.engine.log |
| nimble2 | diagnostic | completed | 27/30/30 | 0 | 0 | 0 | 0.089 | 0.162 | 6110/7095 | — |
| intern2 | holdout | completed | 26/30/30 | 0 | 1 | 0 | 0.123 | 0.193 | 266/407 | — |

60 заранее размеченных RU/EN примеров: 30 диагностических и 30 отложенных. Эталоны не передаются модели. Отложенный набор получает только лучший завершивший диагностику судья. Калибровочные параметры авторов не подгоняются к этому набору.

## Полные guided v4 / prep3 циклы

| Модель | Задача | Статус | Этап | Скрытые проверки | Причина |
|---|---|---|---|---|---|


Выбраны исполнители: нет прошедших скрининг. Судья: intern2.

Не запущены: исполнители qwen-original-f16, qwen-off-f16, qwen-on-f16, qwen-off-q8, neohorse, blend; судьи —; полные циклы [].

## Ограничения и воспроизведение

- Handwritten finite RU/EN fixtures, not a statistical reliability estimate.
- Decision confidence is conditional on the question and does not authorize actions.
- A short probe is not a successful guided workflow.
- Incomplete and unavailable candidates are not counted as incorrect model answers.
- The 4060 drives the Windows desktop; light display load remains and is recorded in startup samples.
- Seed: not-applicable; No fixed generation seed in active model profiles or provider defaults; benchmark --seed injects defects.
- Ошибка запуска, отсутствие памяти и неполный результат отделены от неправильного ответа модели.
- Для вывода о надёжности нужны дополнительные независимые задачи и повторы. По этой серии основные профили автоматически не меняются.

Подготовка: `node bench/model-comparison/prepare.mjs .tmp/model-comparison-20261019 --download`.
Запуск после подготовки окружений: `node bench/model-comparison/run.mjs <новый-каталог-результатов>`.
Полные параметры, ошибки, времена и хеши находятся в manifest.json; сырые запросы — в *.requests.ndjson и raw/.
