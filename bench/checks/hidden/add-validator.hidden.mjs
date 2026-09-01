/**
 * Скрытые тесты задачи add-validator — обёртка над общим раннером семейства billing.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test add-validator.hidden.mjs`.
 */

process.env.BENCH_EXPECTED_SLUG = 'add-validator';
await import('./lib/billing-runner.mjs');
