/**
 * Скрытые тесты задачи cli-flag — обёртка над общим раннером семейства cli-tool.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test cli-flag.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'cli-flag';
await import('./lib/cli-tool-runner.mjs');
