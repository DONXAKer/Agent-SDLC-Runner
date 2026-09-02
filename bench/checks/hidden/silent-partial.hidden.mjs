/**
 * Скрытые тесты задачи silent-partial — обёртка над общим раннером семейства notify.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test silent-partial.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision/human красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'silent-partial';
await import('./lib/notify-runner.mjs');
