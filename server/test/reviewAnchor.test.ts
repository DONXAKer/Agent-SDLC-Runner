import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { anchorAddressValid, anchoredInRequests, normalizeAnchorText, splitByAnchor } from '../src/exec/reviewAnchor.ts';
import { acceptanceIssueFingerprint, intentClaimReviewVerdict } from '../src/exec/intentClaimReview.ts';
import { anchoredPreparationIssues, parsePreparationReviewItems } from '../src/run/preparationReview.ts';

const request = [
  '# Задача',
  'Добавить функцию проверки адреса: email должен содержать «@» и точку в домене,',
  'телефон принимается в международном формате с ведущим «+».',
  'Пустая строка считается ошибкой поля.',
].join('\n');

test('нормализация стирает регистр, кавычки и пунктуацию', () => {
  equal(normalizeAnchorText('  Email ДОЛЖЕН содержать «@» и точку!  '), 'email должен содержать и точку');
});

test('якорь: дословная цитата запроса в кавычках или целиком', () => {
  ok(anchoredInRequests('«телефон принимается в международном формате»', [request]));
  ok(anchoredInRequests('Пустая строка считается ошибкой поля', [request]));
  ok(anchoredInRequests('запрос: "email должен содержать «@» и точку в домене"', [request]));
  // Уточнение рецензента, которого в запросе нет, — не якорь.
  equal(anchoredInRequests('телефон должен состоять ровно из 10 цифр', [request]), false);
  // Цитата есть, но не из запроса — отбрасывается, даже если остальной текст общий.
  equal(anchoredInRequests('по запросу «нужен тест на пустую строку»', [request]), false);
  // Короткое совпадение случайно.
  equal(anchoredInRequests('«email»', [request]), false);
});

test('якорь: адрес request-N:Lx-Ly действителен только внутри запроса', () => {
  ok(anchorAddressValid('request-1:L2-L3', [request]));
  ok(anchorAddressValid('request-1:L4 — последняя строка', [request]));
  equal(anchorAddressValid('request-2:L1-L2', [request]), false);
  equal(anchorAddressValid('request-1:L3-L9', [request]), false);
  ok(anchoredInRequests('request-1:L2-L3 «что угодно»', [request]));
});

test('без запросов якорь не проверяется', () => {
  ok(anchoredInRequests('что угодно', []));
  deepStrictEqual(splitByAnchor([{ basis: 'x' }], [], (item) => item.basis).dropped, []);
});

test('ревью приёмки: замечание без якоря уходит в dropped, с якорем — в problems с ключом повтора', () => {
  const answer = JSON.stringify({ issues: [
    { claimId: 'claim-1', problem: 'нет проверки длины', basis: 'телефон должен быть ровно 10 цифр', counterexample: '+7 123' },
    { claimId: 'claim-2', problem: 'пустая строка принята', basis: '«Пустая строка считается ошибкой поля»', counterexample: '""' },
  ] });
  const verdict = intentClaimReviewVerdict(answer, ['claim-1', 'claim-2'], [request]);
  equal(verdict.problems.length, 1);
  equal(verdict.problems[0]!.key, acceptanceIssueFingerprint('claim-2', 'пустая строка принята'));
  ok(verdict.problems[0]!.text.startsWith('claim-2: пустая строка принята; основание:'));
  equal(verdict.dropped.length, 1);
  ok(verdict.dropped[0]!.startsWith('claim-1: замечание без основания в запросе отброшено'));
});

test('fingerprint приёмки стабилен к перефразировке и пунктуации', () => {
  equal(
    acceptanceIssueFingerprint('claim-1', 'Нет проверки длины телефона!'),
    acceptanceIssueFingerprint('claim-1', 'нет проверки длины телефона'),
  );
  equal(acceptanceIssueFingerprint('claim-1', 'A'), acceptanceIssueFingerprint('claim-1', 'a'));
});

test('ревью приёмки: замечание про будущий артефакт судится тем же якорем, а не словами рецензента', () => {
  // Без цитаты запроса — отброшено как любое неякорённое; с настоящей цитатой — замечание,
  // даже если его формулировка похожа на «файл ещё не создан»: отдельного фильтра по словам нет.
  const answer = JSON.stringify({ issues: [
    { claimId: 'missing', problem: 'Отсутствует будущий файл проверки', basis: '«нужен новый файл»', counterexample: 'файл ещё не создан' },
    { claimId: 'claim-1', problem: 'Отсутствует проверка: пустая строка ещё не обрабатывается', basis: '«Пустая строка считается ошибкой поля»', counterexample: '""' },
  ] });
  const verdict = intentClaimReviewVerdict(answer, ['claim-1'], [request]);
  equal(verdict.problems.length, 1);
  equal(verdict.problems[0]!.key, acceptanceIssueFingerprint('claim-1', 'Отсутствует проверка: пустая строка ещё не обрабатывается'));
  equal(verdict.dropped.length, 1);
  ok(verdict.dropped[0]!.startsWith('missing: замечание без основания в запросе отброшено'));
});

test('независимое ревью плана: строковые замечания не судятся, объектные — по basis', () => {
  const items = parsePreparationReviewItems(JSON.stringify({ issues: [
    'свободная строка без основания',
    { issue: 'шаг 2 не проверяет домен', basis: '«точку в домене»', location: 'Шаг 2', counterexample: 'a@b' },
    { issue: 'нет теста на юникод', basis: 'адреса с юникодом должны проходить', location: 'Шаг 3', counterexample: 'ё@пример.рф' },
  ] }));
  equal(items[1]!.location, 'Шаг 2');
  const warnings: string[] = [];
  const kept = anchoredPreparationIssues(items, [request], (reason) => warnings.push(reason));
  deepStrictEqual(kept.map((item) => item.text.split(' — ')[0]), ['свободная строка без основания', 'шаг 2 не проверяет домен']);
  equal(warnings.length, 1);
  ok(warnings[0]!.includes('без основания в запросе'));
});
