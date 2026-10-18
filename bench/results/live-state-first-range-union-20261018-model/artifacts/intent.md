# Задача: range union

- **Контур:** мелкий
- **Ветка витка:** sdlc/range-union

## Задача от человека

Export mergeRanges(ranges) from src/ranges.mjs. Input is an array of [start,end] finite number pairs with start <= end. Return sorted merged ranges: overlapping or touching ranges merge. Empty input returns []. Do not mutate the input or share output pair arrays with it. Invalid pairs, reversed endpoints or nonfinite numbers throw TypeError.
Preserve existing exports and tests. Add at least one executable test in test/. Only src/ and test/ are writable; existing tests are protected.


## Приёмка

| id | Пункт | Как проверить |
|---|---|---|
| claim-1 | Export mergeRanges: sort and merge overlapping/touching finite numeric [start,end] pairs; [] returns []. | Named independent behavior check |
| claim-2 | Do not mutate input or share output pair arrays with input. | Frozen input and alias tests |
| claim-3 | Invalid pairs, reversed endpoints and nonfinite numbers throw TypeError. | Invalid-input table |
| claim-4 | Preserve existing exports and tests; add an executable test under test/. Only src/ and test/ may change; existing tests are protected. | API, protected-file hash, new test and scope checks |
