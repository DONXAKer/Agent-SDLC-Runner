# Сравнение моделей и настроек

Статус: **completed**. Начало: 2026-10-19T21:50:03.086Z. Завершение: 2026-10-19T21:51:53.424Z.
GPU-бюджет: 41.03815 минут; использовано 1.8.
Отпечаток исходников: `ad4dd79f900c02b08957f4d9de643d449dc325d84a92c34a5c2eb0ab5c91a360`. Старый пилот не возобновлялся.

## Исполнители: короткий скрининг

| Вариант | Статус | Проверки | GPU-размещение | Причина |
|---|---|---|---|---|


Успех скрининга не означает успех полного процесса. Пробы используют штатный provider и PREFLIGHT_CASES.

## Судьи: независимые типизированные решения

| Модель | Набор | Статус | Верно/валидно/всего | Ложное разрешение scope | Ложная блокировка scope | Неподтверждённые утверждения | Brier | ECE | P50/P95 валидных ответов, мс | Причина |
|---|---|---|---|---|---|---|---|---|---|
| standard3 | diagnostic | unavailable | — | — | — | — | — | — | — | Error: Author SGLang unavailable/failed to load; inspect standard3.engine.log |

60 заранее размеченных RU/EN примеров: 30 диагностических и 30 отложенных. Эталоны не передаются модели. Отложенный набор получает только лучший завершивший диагностику судья. Калибровочные параметры авторов не подгоняются к этому набору.

## Полные guided v4 / prep3 циклы

| Модель | Задача | Статус | Этап | Скрытые проверки | Причина |
|---|---|---|---|---|---|


Выбраны исполнители: нет прошедших скрининг. Судья: не выбран.

Не запущены: исполнители qwen-original-f16, qwen-off-f16, qwen-on-f16, qwen-off-q8, neohorse, blend; судьи nimble-installed, intern2, intern4, standard8, nimble2; полные циклы [].

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
