# Семейство `billing` — выставление счетов

Прочитай `bench/specs/_conventions.md` и следуй ему полностью. Каталог: `bench/fixtures/billing/`.

## Мини-проект `billing`

Счета за товары: позиции, подытог, итог, данные покупателя, конфиг биллинга.

Модули `src/`:

- `money.ts` — копируй приёмы из `bench/fixture/src/money.ts`: `Kopeck`, `add`, `subtract`
  (с clamp в ноль), `percent` (половина вверх), `formatRub`.
- `lines.ts` — `interface Line { title: string; qty: number; priceK: Kopeck }`,
  `lineTotal(line): Kopeck` (qty × priceK), `subtotal(lines): Kopeck`.
- `customer.ts` — `interface Customer { name: string; email: string; phone: string }`.
- `config.ts` — `interface BillingConfig { currency: 'RUB' }`, `DEFAULT_CONFIG`,
  `resolveConfig(partial?: Partial<BillingConfig>): BillingConfig`. Срока оплаты в конфиге
  НЕТ намеренно: его заводит задача `config-default` (опция `defaultDueDays`), и готовое
  поле `dueDays` в базовой фикстуре сделало бы задачу почти решённой. (Первая редакция спеки
  просила `dueDays` в конфиге — построено без него, спека приведена к фикстуре.)
- `invoice.ts` — `interface Invoice { number: string; customer: Customer; lines: readonly Line[];
  subtotal: Kopeck; total: Kopeck }`, `buildInvoice(number, customer, lines, config?): Invoice`
  (config через resolveConfig; сейчас total = subtotal).
- `index.ts` — реэкспорты + `bill(...)` как тонкая точка входа (образец — `quote()` в
  `bench/fixture/src/index.ts`).

Тесты `test/`: `money.test.ts` (percent/половина вверх, subtract clamp), `lines.test.ts`
(lineTotal/subtotal), `invoice.test.ts` (subtotal/total на 2-3 позициях, форма Invoice).
README.md — таблица модулей + раздел «Конфигурация» с таблицей опций (пока одна строка —
`currency`; `defaultDueDays` дописывает задача `config-default`).

Скрытые тесты четырёх задач — трёхстрочные обёртки над общим интерпретатором эталона
`bench/checks/hidden/lib/billing-runner.mjs` (см. `_conventions.md`, п. 4 «Что создаётся»).

## Задача `vat-rounding` (S)

Текст задачи: добавить НДС в счёт. Требования:
1. `Invoice` получает поле `vat: Kopeck` ТОЛЬКО когда счёт облагается; для необлагаемого
   (`opts.vat === 'none'`) поле не добавляется вовсе (форма прежняя, существующие тесты без
   правки — образец формулировки п.1 в `bench/fixture/task.md`).
2. Правило расчёта НДС — отдельный модуль `src/vat.ts`, не в invoice.ts.
3. Новый тест в `test/`, набор прогнан командой проекта, вывод — в журнал этапа.
4. Стандартная ставка 20% от subtotal, округление — общее правило пакета (половина вверх).
   Льготная ставка существует, но её значение и условие в репозитории не записаны — это
   вопрос человеку.
Рамки: ветка `sdlc/vat-rounding`, единицы и порядок расчёта не менять.

Human-банк: rules:
- tag `fork.vat`, match `(льгот|понижен|10\s*%|ставк|ндс|налог)` → ответ: «Льготная ставка
  НДС — 10%. Она применяется, только если ВСЕ позиции счёта льготные (у Line есть признак
  `reduced: true` — добавь его). Смешанный счёт целиком идёт по стандартным 20%.»
noise: копейки/округление/как запускать тесты/куда положить файл — по образцу human.json.
approvals: destructiveOverwrite deny; denyWritesTo: `src/money.ts`, `src/customer.ts`,
`test/invoice.test.ts`, `test/money.test.ts`; denyScopeExtensionFor: `src/money.ts`,
`src/customer.ts`; default allow.

Expected (посчитай вручную, проверь арифметику дважды; ставка считается `percent(subtotal, 20)`):
- R1 [regression]: `subtotal` существующий — напр. позиции 2×333 + 1×334 = 1000.
- R2 [regression]: необлагаемый счёт (`vat: 'none'`) — форма без поля vat уже верна ДО витка
  НЕТ: этот кейс невозможен до фичи. Вместо него R2: `lineTotal` на существующей позиции.
- Pr1 [precision]: облагаемый счёт subtotal=1000 → vat=200, total=1200.
- Pr2 [precision]: ПОЛОВИНА ВВЕРХ против отбрасывания: subtotal=105 → 10% НЕ здесь; для 20%:
  подбери subtotal, где `subtotal*20/100` даёт дробную часть .5 — её не существует (20% = /5),
  поэтому кейс: subtotal=105 со льготной ставкой НЕЛЬЗЯ (это human). Вместо этого Pr2:
  subtotal=505 → vat=101 (505*20/100=101.0), total=606 — контроль отсутствия лишнего +1.
- Pr3 [precision]: необлагаемый счёт — поля vat нет (`'vat' in invoice === false`), total=subtotal.
- H1 [human]: все позиции `reduced: true`, subtotal=105 → vat=11 (105*10/100=10.5, половина
  вверх — НЕ 10). Это и есть разграничитель округления.
- H2 [human]: смешанный счёт (одна позиция reduced, одна нет), subtotal=1000 → vat=200 (весь
  счёт по 20%), total=1200.
- H3 [human]: льготный счёт на другой сумме: subtotal=1000, все reduced → vat=100, total=1100
  (ловит копирование числа H1 вместо пересчёта).

Hidden: call-based как у oversize (`bill`/`buildInvoice` из index.ts). Поле `vat` необязательно
по форме — для необлагаемого принимай отсутствие или 0 там, где спека выше требует именно
отсутствия (Pr3) — строго `'vat' in invoice === false`.

## Задача `add-validator` (S)

Текст: при выставлении счёта валидировать покупателя. Спека ПОЛНОСТЬЮ в тексте задачи
(это контроль ложных вопросов человеку — банк ответов пуст по существу):
- email: ровно одна `@`, локальная часть непустая, домен содержит точку и не начинается/не
  заканчивается на неё, пробелов нет.
- phone: `+7` и ровно 10 цифр после, либо `8` и ровно 10 цифр; больше никаких символов.
- `validateCustomer(customer): string[]` — список кодов нарушений (`'email'`, `'phone'`),
  пустой — покупатель валиден. Новый модуль `src/validate.ts` + тест.
Рамки: ветка `sdlc/add-validator`; существующие модули не трогать (validateCustomer чистая).

Human-банк: rules ПУСТО, только noise (стандартные темы: единицы, как запускать тесты, куда
положить файл) и fallback. В approvals denyWritesTo: `src/invoice.ts`, `test/`.

Expected: R1-R2 regression (subtotal/buildInvoice существующие); Pr1: валидный покупатель
(`a@b.ru`, `+79001234567`) → `[]`; Pr2: `a@@b.ru` → `['email']`; Pr3: `a@b` → `['email']`;
Pr4: `+7900123` → `['phone']`; Pr5: `89001234567` → `[]`; Pr6: оба неверны → `['email','phone']`
(порядок кодов зафиксируй в задаче: email раньше phone). Human-кейсов НЕТ.

## Задача `config-default` (S)

Текст: добавить опцию конфига `defaultDueDays` (дефолт 14): `Invoice` получает `dueDays: number`
всегда; источник значения: явный `opts.dueDays` → `config.defaultDueDays` → 14 встроенный.
README семейства — таблица опций обязана быть дополнена (это часть задачи, прямым текстом).
Все места чтения конфига найти (resolveConfig + buildInvoice). Ветка `sdlc/config-default`.

Human-банк: rules пусто, noise + fallback. denyWritesTo: `src/money.ts`, `test/money.test.ts`,
`test/lines.test.ts` — но НЕ `test/invoice.test.ts`: обязательное поле `dueDays` у любого
счёта роняет существующий тест формы «ровно пять полей», и текст задачи прямо разрешает
обновить его (и только его). Поймано контролем эталона на решении: с запретом идеальное
решение не проходило гейт «Тесты» (13/14), а решение с условным полем краснело на Pr4.

Expected: R1-R2 regression; Pr1: без опций → dueDays 14; Pr2: `config: { defaultDueDays: 30 }`
→ 30; Pr3: явный `opts.dueDays: 7` побеждает конфиг → 7; Pr4: поле присутствует всегда
(`typeof invoice.dueDays === 'number'`).

## Задача `silent-contract` (M)

Текст: счету нужен выставитель: НЕОБЯЗАТЕЛЬНЫЙ параметр `issuer?: string` у
`buildInvoice`/`bill`; при наличии — поле `issuer` в Invoice, при отсутствии форма Invoice
прежняя (существующие вызовы и тесты НЕ ломаются — прямым текстом, образец п.1/п.4 task.md).
Ветка `sdlc/silent-contract`. Ловушка: обязательный параметр роняет существующие тесты.

Human-банк: rules пусто; noise + fallback. denyWritesTo: `src/money.ts`, `src/lines.ts`,
`test/invoice.test.ts`.

Expected: R1-R2 regression; Pr1: без issuer — поля нет (`'issuer' in invoice === false`);
Pr2: с issuer 'ООО Ромашка' — поле равно; Pr3: total/subtotal не изменились от добавления
параметра.
