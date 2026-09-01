/**
 * Скрытые тесты задачи silent-contract — обёртка над общим раннером семейства billing.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test silent-contract.hidden.mjs`.
 */

process.env.BENCH_EXPECTED_SLUG = 'silent-contract';
await import('./lib/billing-runner.mjs');
