/**
 * Скрытые тесты задачи plan-only-trap — обёртка над общим раннером семейства cli-tool.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test plan-only-trap.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'plan-only-trap';
await import('./lib/cli-tool-runner.mjs');
