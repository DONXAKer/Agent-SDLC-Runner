# Полный guided-цикл с независимой приёмкой

Статус: **complete**. Завершено: 30/30. Успех: 0.

| Модель | Задача | Статус | Успех | Причина |
|---|---|---|---|---|
| ollama:comparison-qwen-off-q8 | add-validator | complete | false | guided: Три предложения подряд не изменяют код; требуется пересмотреть гипотезу; применено 0 |
| ollama:comparison-qwen-off-q8 | config-default | complete | false | Техническая остановка разрешения вопросов: 4213f9bd15126fff: context: Не удалось добрать исходник в пределах бюджета: Нужно увидеть текущую реализацию resolveConfig и DEFAULT_CONFIG, чтобы определить, где именно будет добавлено поле defaultDueDays и как будет применяться встроенный дефолт 14. |
| ollama:comparison-qwen-off-q8 | rename-field | complete | false | guided: Исследование группы не дало результата за 6 запросов; применено 0 |
| ollama:comparison-qwen-off-q8 | idempotent-retry | complete | false | guided: Исследование группы не дало результата за 6 запросов; применено 0 |
| ollama:comparison-qwen-off-q8 | vat-rounding | complete | false | Техническая остановка разрешения вопросов: bf676951069860f0: context: Не удалось добрать исходник в пределах бюджета: Нужно подтвердить точную сигнатуру и реализацию функции percent, чтобы в новом модуле src/vat.ts корректно использовать общее правило округления пакета. |
| ollama:mellum2-12b-instruct-q6 | add-validator | complete | false | Ремонт контракта не изменил адресованные секции |
| ollama:mellum2-12b-instruct-q6 | config-default | complete | false | Контракт Intent противоречив после трёх ремонтов: Противоречие в установке значения по умолчанию для dueDays; Противоречие в иерархии приоритетов dueDays; Противоречие в объявлении обязательного поля dueDays в Invoice; Противоречие в согласованности использования resolveConfig; Противоречие в изменении теста формы счёта |
| ollama:mellum2-12b-instruct-q6 | rename-field | complete | false | Контракт Intent противоречив после трёх ремонтов: Противоречие между требованием к serialize и условием при парсинге при наличии обоих полей |
| ollama:mellum2-12b-instruct-q6 | idempotent-retry | complete | false | Контракт Intent противоречив после трёх ремонтов: Противоречие в реализации исходного запроса: «serialize пишет только sku» против «не удаляем code из сериализации»; Противоречие в реализации исходного запроса: «serialize пишет только sku» против «не удаляем code из сериализации»; Противоречие в реализации исходного запроса: «serialize пишет только sku» против «не удаляем code из сериализации» |
| ollama:mellum2-12b-instruct-q6 | vat-rounding | complete | false | Контракт Intent противоречив после трёх ремонтов: Противоречие в определении поведения при необлагаемом счёте: условие L13-L14 гласит, что объект остаётся прежней формой { number, customer, lines, subtotal, total }, а не получает vat: 0, однако Инвариант L1-L2 не исключает возможного добавления поля vat с нулевым значением в других сценариях.; Отсутствие уточнения о стандартной ставке НДС в сценарии L27: условие гласит, что значения и условия применения ставок нельзя вывести, только спросить, но при этом Инвариант L1-L2 требует корректного расчёта налога для облагаемого счёта, что подразумевает knowledge о ставке.; Неясно, в каком модуте реализуется правило расчёта налога для облагаемого счёта, несмотря на условие L7-L8, что правило лежит в src/vat.ts, но отсутствует ссылка на этот модуль в секции «Что делаем» или «Приёмочный лист». |
| ollama:gpt-oss-20b-ctx32k | add-validator | complete | false | План не подготовлен: карта плана разошлась с кодовой базой; вернись на этап 4 до расхода попытки: - шаг 2: символ resolveConfig не найден в src/index.ts и не подтверждён как новый требуемый символ |
| ollama:gpt-oss-20b-ctx32k | config-default | complete | false | План не подготовлен: Unterminated string in JSON at position 1848 (line 1 column 1849) |
| ollama:gpt-oss-20b-ctx32k | rename-field | complete | false | guided: Повторено отклонённое предложение при неизменных файлах: Предложенная группа НЕ применена. Состояние файлов на диске не изменено этой группой; диагностический snippet может описывать промежуточную симуляцию, а не диск. Для ремонта используй актуальный workingContext или Read. replace_body: закреплён function product, но получено другое полное объявление (interface Product). Верни тело или полное объявление именно product; другой символ требует отдельного шага плана.; применено 2 |
| ollama:gpt-oss-20b-ctx32k | idempotent-retry | complete | false | План не подготовлен: карта плана разошлась с кодовой базой; вернись на этап 4 до расхода попытки: - шаг 1: символ idempotentStorageMap не найден в src/sender.ts и не подтверждён как новый требуемый символ - шаг 2: символ verifyIndexExport не найден в src/index.ts и не подтверждён как новый требуемый символ |
| ollama:gpt-oss-20b-ctx32k | vat-rounding | complete | false | guided: Диагноз проверки не завершён; применено 4 |
| ollama:ministral3-14b-instruct-ctx32k | add-validator | complete | false | Нет адресованного ремонта intent:proposal:intent:repair:0:Основания и сценарии: Ремонт меняет набор ID требований |
| ollama:ministral3-14b-instruct-ctx32k | config-default | complete | false | Intent не готов: незаполненных полей 1; проверка приёмки отклонена |
| ollama:ministral3-14b-instruct-ctx32k | rename-field | complete | false | Нет адресованного ремонта intent:proposal:intent:repair:1:Основания и сценарии: Ремонт меняет набор ID требований |
| ollama:ministral3-14b-instruct-ctx32k | idempotent-retry | complete | false | Нет адресованного ремонта intent:proposal:intent:repair:1:Основания и сценарии: Ремонт меняет набор ID требований |
| ollama:ministral3-14b-instruct-ctx32k | vat-rounding | complete | false | Intent не готов: незаполненных полей 1; проверка приёмки отклонена |
| ollama:devstral-small-2 | add-validator | complete | неизвестно | Engine layout failure: Error: Declared fully GPU model/context not confirmed |
| ollama:devstral-small-2 | config-default | complete | неизвестно | Engine layout failure: Error: Declared fully GPU model/context not confirmed |
| ollama:devstral-small-2 | rename-field | complete | неизвестно | Engine layout failure: Error: Declared fully GPU model/context not confirmed |
| ollama:devstral-small-2 | idempotent-retry | complete | неизвестно | Engine layout failure: Error: Declared fully GPU model/context not confirmed |
| ollama:devstral-small-2 | vat-rounding | complete | неизвестно | Engine layout failure: Error: Declared fully GPU model/context not confirmed |
| ollama:comparison-neohorse | add-validator | complete | false | этап отменён оператором |
| ollama:comparison-neohorse | config-default | complete | false | этап отменён оператором |
| ollama:comparison-neohorse | rename-field | complete | false | этап отменён оператором |
| ollama:comparison-neohorse | idempotent-retry | complete | false | этап отменён оператором |
| ollama:comparison-neohorse | vat-rounding | complete | false | этап отменён оператором |

Приёмочные тесты подготовлены до реализации и выполняются в Docker без сети. Скрытый оценщик выполняется отдельно. Решения оператора автоматизированы стендом. Один повтор; окна и параметры моделей сохранены в манифесте, различия конфигураций ограничивают сравнение. Остановка до Verify не считается проверкой Verify.
