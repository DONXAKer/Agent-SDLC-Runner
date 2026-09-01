# Семейство `payments-mock` — клиент платёжного API

Прочитай `bench/specs/_conventions.md` и следуй ему полностью. Каталог: `bench/fixtures/payments-mock/`.

## Мини-проект `pay-client`

Клиент внешнего платёжного API. HTTP не нужен: транспорт инъектируется функцией, мок —
in-process handler. Сети в тестах нет.

Модули `src/`:

- `transport.ts` — `type HttpPost = (path: string, body: string) => { status: number; body: string }`.
- `mock.ts` — `mockBank(): HttpPost` — реализация КОНТРАКТА (см. README): принимает
  POST /charge с телом JSON, отвечает по контракту. Мок — единственная реализация контракта
  в репозитории, и он ПРАВИЛЬНЫЙ (это эталон поведения внешней системы). Набор карт в моке:
  токен `tok_ok` — успех; `tok_decline` — отказ insufficient_funds; `tok_fraud` — отказ
  fraud_suspected; любой другой — отказ unknown_card.
- `client.ts` — ПУСТОЙ каркас: `charge(http: HttpPost, req: ChargeRequest): ChargeResult` —
  сейчас `throw new Error('не реализовано')`? НЕТ — пусть отсутствует вовсе; точнее:
  client.ts содержит только типы `ChargeRequest { cardToken: string; amountK: number;
  currency: 'RUB' }` и `ChargeResult` (см. ниже), без реализации.
- `index.ts` — реэкспорты типов и mockBank.

README.md — КОНТРАКТ ВНЕШНЕГО API (это единственная его спецификация, текстом и примером):
- POST /charge, тело JSON: `{"card_token":"...","amount_minor":"12345","currency":"RUB"}` —
  поля в ЗМЕИНОМ регистре, сумма СТРОКОЙ в минорных единицах (копейках).
- Ответ ВСЕГДА HTTP 200 с телом: успех `{"ok":true,"charge_id":"ch_..."}`; отказ
  `{"ok":false,"error":{"code":"insufficient_funds","message":"..."}}`. HTTP-статусы ошибок
  не используются — отказ распознаётся по `ok:false`, а не по статусу.
- `ChargeResult`: `{ status: 'ok'; chargeId: string } | { status: 'declined'; code: string }`.

Тесты `test/`: `mock.test.ts` — мок сам протестирован по контракту (ok/decline/unknown).
Это зелёный набор пристинной фикстуры.

## Задача `external-contract` (M)

Текст: реализовать `charge(http, req)` в client.ts по контракту из README. Требования:
1. Тело запроса — ровно по контракту: змеиный регистр, `amount_minor` СТРОКОЙ.
2. Отказ — по `ok:false` в теле (HTTP 200), а не по статусу; `ChargeResult.status:
   'declined'` с кодом из `error.code`.
3. Успех — `{ status: 'ok', chargeId }`.
4. Новый тест через mockBank (не через интернет). Существующие тесты без правки.
Ветка `sdlc/external-contract`. Ловушки: привычный REST (camelCase, число, HTTP 4xx) — всё
мимо контракта.

Human-банк: rules пусто (контракт полон в README — вопросы лишние), noise: «какой формат/
какой статус при отказе» → «всё записано в README контракта». denyWritesTo: `src/mock.ts`,
`test/mock.test.ts` (мок — эталон, править его = подогнать стенд).

Expected (call-based, http = mockBank()):
- R1-R2 [regression]: mockBank сам: charge tok_ok → ok:true; tok_decline → ok:false
  (зовут мок напрямую — зелёные на пристинной).
- Pr1 [precision]: charge(mock, {cardToken:'tok_ok', amountK:12345, currency:'RUB'}) →
  {status:'ok', chargeId непустой}. Pr2: tok_decline → {status:'declined', code:
  'insufficient_funds'}. Pr3: tok_fraud → code 'fraud_suspected'.
- Pr4 [precision]: ТОЧНОЕ тело запроса: оберни mockBank шпионом в hidden-тесте (свой HttpPost,
  записывающий body) и сравни body дословно:
  `{"card_token":"tok_ok","amount_minor":"12345","currency":"RUB"}` — порядок ключей зафиксируй
  в тексте задачи (как в README-примере), amount строкой.
- Pr5: unknown токен → declined/unknown_card.
На пристинной Pr1-Pr5 красные (функции нет), R1-R2 зелёные.
