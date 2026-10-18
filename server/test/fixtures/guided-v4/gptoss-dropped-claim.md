<!-- sdlc-template: intent v1 -->
# Задача: название

> Проработка v3. ИИ готовит структурированный черновик; человек подтверждает требования вместе с планом.
- **Контур:** полный
- **Ветка витка:** sdlc/add-validator

## Коротко
Коротко

## Зачем
Валидация контактов покупателя обеспечивает корректность данных, выставляемых в счёте, и предотвращает рассылку счетов с опечатками в e‑mail или телефоне, которые приводят к задержке оплаты и необходимости вручную уточнять данные. Это решение устраняет проблемы некорректного выставления счетов, повышает надёжность документооборота и ускоряет процесс получения платежей.

## Что делаем
- Разработан новый модуль `src/validate.ts`, в котором реализована функция `validateCustomer(customer: Customer): string[]`. Функция выполняет проверки по правилам email и телефона, соблюдая строгий порядок возврата кодов: сначала «email», затем «phone». Если нарушение найдено – код добавляется в массив в указанном порядке; если нет – массив остаётся пустым. Функция остаётся чистой, не производя побочных эффектов.  Функция переэкспортирована из `src/index.ts` как `export { validateCustomer } from './validate'`, удовлетворяя требованию «validateCustomer реэкспортируется из src/index.ts».  Ни один

## Чего не делаем
- Не меняем существующие модули и тесты проекта.
- Валидацию оставляем как отдельный модуль: она не вызывается из функции `buildInvoice` и не влияет на логику генерации счета.
- Не добавляем внешние зависимости – используем только чистый TypeScript.
- Не создаём UI‑компоненты и не пишем дополнительную документацию о работе модулей.
- Логирование действий в рамках данного ветка‑ветки не ведём.
- Интеграцию валидатора в `buildInvoice` оставляем для будущего спринта.

## Приёмочный лист
| ID | Пункт | Как проверить (процедура + критерий) |
|---|---|---|
| claim-1 | Новый модуль src/validate.ts с функцией validateCustomer(customer): string[]. Возврат – список кодов нарушений. Пустой массив означает валидность покупателя. Коды фиксированы: сначала 'email', затем 'phone'. Функция чистая – ничего не пишет, не меняет данные. | Процедура: Вызвать validateCustomer(customer) с объектом Customer. Ожидаемый результат – массив кодов нарушений. Пустой массив обозначает валидность покупателя. Ожидаемый порядок: 'email' → 'phone'.. Ожидаемо: Массив строк, упорядоченный по 'email' и 'phone'. |
| claim-2 | Проверка email: ровно один символ '@'; локальная часть непустая; домен содержит точку и не начинается и не заканчивается на неё; пробелов нигде нет. | Процедура: Передать в validateCustomer customer с email, нарушающим каждое правило (например: 'user@@domain.com', '@domain.com', 'user@', 'user@.com', 'user@domaincom', 'user @domain.com'). Ожидаемый результат – в массиве код 'email', первый элемент.. Ожидаемо: Массив содержит 'email' как первый код при любой из описанных ошибок. |
| claim-3 | Проверка телефона: либо +7 и ровно 10 цифр следом, либо 8 и ровно 10 цифр. Допускаются только цифры, никаких пробелов, скобок, дефисов. | Процедура: Проверить номера, нарушающие правила (например: '+71 234567890', '81234567890', '8-1234567890'). Ожидаемый результат – в массиве код 'phone', второй элемент.. Ожидаемо: Массив содержит 'phone' как второй код при любой из описанных ошибок. |
| claim-4 | Функция validateCustomer экспортируется из src/index.ts. Тесты модуля размещаются рядом с существующими в test/. | Процедура: Импортировать validateCustomer из src/index.ts и проверить его работу согласно claim‑1–3. Ожидаемый результат – функция доступна для импорта и ведёт себя как определено.. Ожидаемо: Функция успешно импортируется и функционирует согласно требованиям. |

## Основания и сценарии
| Основание | Сценарий | Контрпример | ID |
|---|---|---|---|
| request-1:L8-L8 «1. Новый модуль `src/validate.ts` с `validateCustomer(customer): string[]` — список кодов» | The system should provide validateCustomer that returns an array of violation codes in the order 'email', then 'phone'. | If the returned array lists 'phone' before 'email' or includes an unexpected code, the requirement is violated. | claim-1 |
| request-1:L9-L9 «нарушений. Пустой список — покупатель валиден. Коды и их порядок фиксированы: сначала» | Email validation must ensure exactly one '@', a non‑empty local part, a domain containing a dot that does not start or end with a dot, and no spaces. | An email like 'user@@domain.com' would incorrectly pass validation if the rule about a single '@' is not enforced. | claim-2 |
| request-1:L10-L10 «`'email'`, затем `'phone'`. Функция чистая: ничего не пишет и ничего не меняет.» | Phone validation requires either '+7' or '8' followed by exactly 10 digits, with no other characters allowed. | A number such as '(+7)1234567890' would pass validation incorrectly if parentheses are not rejected. | claim-3 |
| request-1:L11-L11 «2. Правила email: ровно одна `@`; локальная часть непустая; домен содержит точку и не» | validateCustomer must be re‑exported from src/index.ts and have dedicated tests alongside existing ones. | If validateCustomer is not exported, the test harness cannot import it, breaking the test suite. | claim-4 |
| request-1:L12-L12 «начинается и не заканчивается на неё; пробелов нигде нет.» | Existing modules and tests should remain untouched; validation is a separate function not invoked in buildInvoice. | Adding a call to validateCustomer inside buildInvoice would alter its behavior and violate the requirement. | claim-5 |

## Инварианты
н/п — проектных инвариантов пока не выявлено; проверить при исследовании

## Когда остановиться и спросить
Новый существенный контракт, изменение поведения или противоречие исходному запросу.

## Что придётся тронуть
Будет уточнено исследованием.

## Открытые вопросы
Нет зафиксированных вопросов; выявить существенные неизвестные при исследовании.
