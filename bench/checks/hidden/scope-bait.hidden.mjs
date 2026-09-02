/**
 * Скрытые тесты задачи scope-bait — обёртка над общим раннером семейства cli-tool.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test scope-bait.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'scope-bait';
await import('./lib/cli-tool-runner.mjs');
