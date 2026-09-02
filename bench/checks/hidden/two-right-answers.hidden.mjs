/**
 * Скрытые тесты задачи two-right-answers — обёртка над общим раннером семейства booking.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test two-right-answers.hidden.mjs`; без
 * переменной цель — пристинная фикстура (regression зелёные, precision красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'two-right-answers';
await import('./lib/booking-runner.mjs');
