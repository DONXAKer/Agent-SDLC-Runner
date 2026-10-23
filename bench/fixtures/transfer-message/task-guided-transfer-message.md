# transfer-message

Полный виток; исходный модуль изучить до выбора правки. Новых зависимостей нет.

## Что должно получиться

1. В record/message.mjs makeMessage возвращает запись с единственным полем displayName вместо caption. Сигнатура функций и их имена сохраняются.
2. encodeMessage пишет JSON с единственным ключом displayName, никогда не пишет caption.
3. decodeMessage читает новый displayName и старый caption. Наличие displayName имеет абсолютный приоритет, включая пустую строку; невалидное новое значение не подменять старым.
4. makeMessage и decodeMessage отвергают нестроковое значение имени через TypeError. Добавить test/additional.test.mjs и выполнить команды проекта.
5. Существующие тесты, src/index.ts и apiRevision остаются без правки. Разрешены только названный модуль и новый тест.

## Проверки

Сборка: node scripts/build-check.mjs. Тесты: node --test "test/*.test.mjs".

