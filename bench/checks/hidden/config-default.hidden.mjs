/**
 * Скрытые тесты задачи config-default — обёртка над общим раннером семейства billing.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test config-default.hidden.mjs`.
 */

process.env.BENCH_EXPECTED_SLUG = 'config-default';
await import('./lib/billing-runner.mjs');
