# Сравнение моделей и настроек

Статус: **completed**. Начало: 2026-10-19T19:31:05.375Z. Завершение: 2026-10-19T20:04:12.104Z.
GPU-бюджет: 180 минут; использовано 33.1.
Отпечаток исходников: `1bfec1912db3a7de1768bb7971c84a72b0df1ec192b0a1309c99abd3ff448620`. Старый пилот не возобновлялся.

## Исполнители: короткий скрининг

| Вариант | Статус | Проверки | GPU-размещение | Причина |
|---|---|---|---|---|
| qwen-original-f16 | screen-failed | 6/7 | true |  |
| qwen-off-f16 | screen-failed | 6/7 | true |  |
| qwen-on-f16 | screen-failed | 5/7 | true |  |
| qwen-off-q8 | screen-passed | 7/7 | true |  |
| neohorse | screen-failed | 6/7 | true |  |
| blend | screen-failed | 6/7 | true |  |

Успех скрининга не означает успех полного процесса. Пробы используют штатный provider и PREFLIGHT_CASES.

## Судьи: независимые типизированные решения

| Модель | Набор | Статус | Верно/валидно/всего | Ложное разрешение scope | Ложная блокировка scope | Неподтверждённые утверждения | Brier | ECE | P50/P95 валидных ответов, мс | Причина |
|---|---|---|---|---|---|---|---|---|---|
| nimble-installed | diagnostic | unavailable | — | — | — | — | — | — | — | Error: HTTP 400: {"error":"'nimble:latest' was downloaded in a format that is no longer supported. To re-download, run 'ollama pull nimble:latest'"} |
| intern2 | diagnostic | unavailable | — | — | — | — | — | — | — | Error: Worker exited 0 |
| intern4 | diagnostic | unavailable | — | — | — | — | — | — | — | Error: Worker exited 0 |
| standard3 | diagnostic | unavailable | — | — | — | — | — | — | — | Error: Author SGLang unavailable/failed to load; inspect standard3.engine.log |
| standard8 | diagnostic | unavailable | — | — | — | — | — | — | — | Error: Author SGLang unavailable/failed to load; inspect standard8.engine.log |
| nimble2 | diagnostic | unavailable | — | — | — | — | — | — | — | Error: Worker exited 0 |

60 заранее размеченных RU/EN примеров: 30 диагностических и 30 отложенных. Эталоны не передаются модели. Отложенный набор получает только лучший завершивший диагностику судья. Калибровочные параметры авторов не подгоняются к этому набору.

## Полные guided v4 / prep3 циклы

| Модель | Задача | Статус | Этап | Скрытые проверки | Причина |
|---|---|---|---|---|---|
| ollama:comparison-qwen-off-q8 | add-validator | failed | verify | {"total":8,"pass":8,"fail":0,"skipped":0,"cases":[{"ok":true,"skipped":false,"id":"R1","category":"regression","label":"ok 1 - R1 [regression]: lineTotal существует до витка и считает верно."},{"ok":true,"skipped":false,"id":"R2","category":"regression","label":"ok 2 - R2 [regression]: subtotal на эталонном наборе: 2×333 + 1×334 = 1000."},{"ok":true,"skipped":false,"id":"Pr1","category":"precision","label":"ok 3 - Pr1 [precision] (claim-2): Валидный покупатель: нарушений нет."},{"ok":true,"skipped":false,"id":"Pr2","category":"precision","label":"ok 4 - Pr2 [precision] (claim-2): Две собаки — нарушение email (ровно одна @)."},{"ok":true,"skipped":false,"id":"Pr3","category":"precision","label":"ok 5 - Pr3 [precision] (claim-2): Домен без точки — нарушение email."},{"ok":true,"skipped":false,"id":"Pr4","category":"precision","label":"ok 6 - Pr4 [precision] (claim-3): Короткий телефон — нарушение phone (+7 и ровно 10 цифр)."},{"ok":true,"skipped":false,"id":"Pr5","category":"precision","label":"ok 7 - Pr5 [precision] (claim-3): Формат через восьмёрку — валиден (8 и ровно 10 цифр)."},{"ok":true,"skipped":false,"id":"Pr6","category":"precision","label":"ok 8 - Pr6 [precision] (claim-2): Оба поля неверны — оба кода, в фиксированном порядке: email раньше phone."}],"errorText":null} | этап закончился, но артефакт не заполнен: C:\Users\Root\AppData\Local\Temp\sdlc-bench-KdW6Sy\.sdlc\model-comparison-1792438265375-qwen-off-q8-add-validator\verification-report-1-attempt-1.md (1 незаполненных полей) |
| ollama:comparison-qwen-off-q8 | rename-field | failed | chunk | {"total":6,"pass":2,"fail":4,"skipped":0,"cases":[{"ok":true,"skipped":false,"id":"R1","category":"regression","label":"ok 1 - R1 [regression]: Round-trip записи, собранной конструктором: parse(serialize(product('A-1','Шуруп 4×40',100))) возвращает то же название, цену и идентификатор — до переименования и после."},{"ok":true,"skipped":false,"id":"R2","category":"regression","label":"ok 2 - R2 [regression]: loadAll двух строк файла в старом формате (`code`) — читается и до витка, и после: старые файлы обязаны читаться."},{"ok":false,"skipped":false,"id":"Pr1","category":"precision","label":"not ok 3 - Pr1 [precision] (claim-2): Старая строка с `code` читается в новое поле: parse('{\"code\":\"A-1\",…}').sku === 'A-1'."},{"ok":false,"skipped":false,"id":"Pr2","category":"precision","label":"not ok 4 - Pr2 [precision] (claim-3): serialize пишет ключ sku и НЕ пишет ключ code: подстрока '\"sku\":\"A-1\"' есть, подстроки '\"code\"' нет."},{"ok":false,"skipped":false,"id":"Pr3","category":"precision","label":"not ok 5 - Pr3 [precision] (claim-2): Оба имени в строке — побеждает sku: parse('{\"code\":\"OLD\",\"sku\":\"NEW\",…}').sku === 'NEW'."},{"ok":false,"skipped":false,"id":"Pr4","category":"precision","label":"not ok 6 - Pr4 [precision] (claim-1): Round-trip нового формата: parse(serialize({sku,title,priceK})) равен исходной записи целиком — поля code у прочитанной записи нет."}],"errorText":null} | guided: Повторено отклонённое предложение при неизменных файлах: Предложенная группа НЕ применена. Состояние файлов на диске не изменено этой группой; диагностический snippet может описывать промежуточную симуляцию, а не диск. Для ремонта используй актуальный workingContext или Read. Синтаксис черновика src\product.ts: Expected '{', got 'interface'. Файл не записан; исправь операцию.; применено 0 |

Выбраны исполнители: qwen-off-q8. Судья: не выбран.

Не запущены: исполнители —; судьи —; полные циклы [].

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
