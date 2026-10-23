# Сравнение моделей и настроек

Статус: **completed**. Начало: 2026-10-19T20:39:21.890Z. Завершение: 2026-10-19T20:55:32.481Z.
GPU-бюджет: 111.72475 минут; использовано 16.2.
Отпечаток исходников: `63cf13d379f2cceebb2ba5f1aabd0138d5f8dd112853243b0e1bae6bb60f7ec0`. Старый пилот не возобновлялся.

## Исполнители: короткий скрининг

| Вариант | Статус | Проверки | GPU-размещение | Причина |
|---|---|---|---|---|


Успех скрининга не означает успех полного процесса. Пробы используют штатный provider и PREFLIGHT_CASES.

## Судьи: независимые типизированные решения

| Модель | Набор | Статус | Верно/валидно/всего | Ложное разрешение scope | Ложная блокировка scope | Неподтверждённые утверждения | Brier | ECE | P50/P95 валидных ответов, мс | Причина |
|---|---|---|---|---|---|---|---|---|---|
| nimble-installed | diagnostic | unavailable | — | — | — | — | — | — | — | Error: HTTP 400: {"error":"'nimble:latest' was downloaded in a format that is no longer supported. To re-download, run 'ollama pull nimble:latest'"} |
| intern2 | diagnostic | completed | 27/30/30 | 0 | 0 | 0 | 0.112 | 0.166 | 270/330 | — |
| intern4 | diagnostic | completed | 27/30/30 | 0 | 0 | 0 | 0.076 | 0.129 | 385/482 | — |
| standard3 | diagnostic | unavailable | — | — | — | — | — | — | — | Error: Author SGLang unavailable/failed to load; inspect standard3.engine.log |
| standard8 | diagnostic | unavailable | — | — | — | — | — | — | — | Error: Author SGLang unavailable/failed to load; inspect standard8.engine.log |
| nimble2 | diagnostic | incomplete | 6/6/7 | 0 | 0 | 0 | 0.021 | 0.117 | 40029/49474 | Error: Worker exited 15 |
| intern2 | holdout | completed | 26/30/30 | 0 | 1 | 0 | 0.121 | 0.186 | 261/359 | — |

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
