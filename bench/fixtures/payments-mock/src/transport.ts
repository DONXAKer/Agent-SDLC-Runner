/**
 * Транспорт.
 *
 * HTTP слой здесь — функция, а не сеть: клиент обязан тестироваться без сокетов, а эталоном
 * поведения банка служит in-process мок (src/mock.ts). Тело ходит СТРОКОЙ в обе стороны —
 * сериализация и разбор JSON обязанность клиента, не транспорта.
 */

export interface HttpResponse {
  status: number;
  body: string;
}

export type HttpPost = (path: string, body: string) => HttpResponse;
