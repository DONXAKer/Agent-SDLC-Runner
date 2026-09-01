/**
 * Посев дефекта известного класса — стенд для измерения НАХОДИМОСТИ этапа 6.
 *
 * Зачем отдельный механизм. Все прежние замеры рецензентов отвечали на вопрос «дошёл ли
 * до вердикта», и ни один — на вопрос «сколько дефектов пропустил». Журнал признаёт это
 * прямо (r18): самоценз в грубой форме не подтвердился, но «сэмпл был 9/9, пропускать
 * было почти нечего», и честный ответ требует сэмпла С ЗАЛОЖЕННЫМ дефектом. Без такого
 * стенда улучшение этапа 6 неотличимо от ухудшения: рецензент, который стал уверенно
 * закрывать этап, мог начать закрывать его слепым.
 *
 * Как устроено. Посев — точечная замена в файле ФИКСТУРЫ поверх восстановленного снимка
 * «после chunk». Именно фикстуры, а не того, что написала модель: текст модельных файлов
 * от сэмпла к сэмплу разный, и посев по нему то попадал бы, то нет — стенд обязан быть
 * побайтово одинаковым для всех измеряемых моделей. Патч попытки рантайм перегенерирует
 * из дерева сам (`run/evidence.ts`), поэтому посеянное попадает в diff, который читает
 * рецензент, тем же путём, что и работа исполнителя.
 *
 * Цель посева — файл, который у этой задачи заведомо в плане (`src/tariffs.ts`: там живёт
 * `priceFor`, а его правит любой сэмпл). Посев в файл ВНЕ плана меряет не рецензента, а
 * scope-гейт: тот покраснеет и без всякого чтения кода.
 *
 * Два вида посевов и почему нужны оба:
 *  - `expected: 'gate'` — контроль самого стенда. Дефект обязан покраснеть автоматикой
 *    («Тесты», «Анти-обход»); если не покраснел, сломан прогон, а не модель.
 *  - `expected: 'review'` — измерение по существу. Тесты фикстуры такой дефект не видят,
 *    поймать его может только чтение diff'а.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GateRunResult } from '@sdlc-runner/shared';

import { gateKey } from '../../server/src/gates/gatesFile.ts';

export class SeedError extends Error {}

export interface SeedDef {
  id: string;
  /** Класс дефекта — им подписывается строка замера в журнале. */
  klass: string;
  /** Путь в рабочей копии, относительный. */
  file: string;
  /** Точный кусок текста фикстуры. Обязан встречаться РОВНО один раз. */
  find: string;
  replace: string;
  /** Что именно сломано — человеку в отчёт. */
  what: string;
  /** Кто обязан поймать: автоматика (контроль стенда) или чтение diff'а. */
  expected: 'gate' | 'review';
  /**
   * Задачи, на чьих снимках якорь посева существует.
   *
   * Якорь — дословный текст конкретной фикстуры, поэтому посев применим не «везде», а ровно
   * на задачах, чьи каталоги этот текст содержат. Сеять посев на чужом снимке значило бы
   * упасть на дорогом замере с «якорь не найден» — разбор ключей обязан отвергнуть такую
   * комбинацию заранее (см. `options.ts`).
   */
  tasks: readonly string[];
  /**
   * Гейты, краснота которых засчитывается как поимка ИМЕННО этого посева.
   *
   * Список, а не «любой красный гейт»: у прогона краснеет и то, что к посеву отношения не
   * имеет (scope, сборка чужого модуля), и засчитывать это значило бы записывать модели
   * чужую находку. У посевов класса `review` список пуст по существу — автоматика их не
   * видит, и если гейт покраснел, то не из-за них.
   */
  gates: readonly string[];
  /**
   * По каким признакам считается, что дефект НАЗВАН в отчёте приёмки.
   *
   * Не одно слово: рецензент называет дефект своими словами, и требовать дословную
   * формулировку значило бы мерить совпадение словаря, а не находку. Достаточно любого
   * из выражений — все они привязаны к месту (имя функции, число, файл), а не к оценке.
   */
  mentions: readonly RegExp[];
}

/** Специальное значение `--seed`: ничего не сеем, меряем ложные срабатывания. */
export const SEED_NONE = 'none';

export const SEEDS: readonly SeedDef[] = [
  {
    id: 'swallow-tariff-error',
    klass: 'проглоченная ошибка',
    file: 'src/tariffs.ts',
    // Якоря всех шести посевов лежат в src/tariffs.ts и test/tariffs.test.ts общей фикстуры
    // `fixture` — она одна на обе задачи, поэтому обе применимы.
    tasks: ['oversize', 'freeship'],
    what:
      '`basePrice` вместо исключения «тариф не заполнен» молча возвращает цену первой ' +
      'весовой ступени — клиенту выставляется чужая цена вместо отказа',
    find: [
      '  if (price === undefined) {',
      '    throw new Error(`тариф не заполнен: зона ${zone}, вес ${weightG} г`);',
      '  }',
    ].join('\n'),
    replace: ['  if (price === undefined) {', '    return row[0]!;', '  }'].join('\n'),
    expected: 'review',
    gates: [],
    // Тесты фикстуры проверяют лишь `typeof basePrice(...) === 'number'` — подмена
    // исключения возвратом проходит их насквозь.
    mentions: [/basePrice/i, /тариф не заполнен/i, /проглоч/i, /исключени[ея]/i, /row\[0\]/],
  },
  {
    id: 'silent-price-change',
    klass: 'регрессия: молчаливая правка прейскуранта',
    file: 'src/tariffs.ts',
    tasks: ['oversize', 'freeship'],
    what: 'цена msk свыше 5 кг снижена с 62 900 до 62 000 копеек — правка прейскуранта, которой задача не просила',
    find: '    62_900, // свыше 5 кг — двое грузчиков по регламенту',
    replace: '    62_000, // свыше 5 кг — двое грузчиков по регламенту',
    expected: 'review',
    gates: [],
    // «Цена растёт с весом» остаётся истинной (62 000 > 44 900), литеральных ассертов на
    // эту ячейку нет — автоматика молчит.
    mentions: [/62[\s_]?000/, /62[\s_]?900/, /TARIFF_TABLE/i, /прейскурант/i, /тарифн\w+ таблиц/i],
  },
  {
    id: 'longest-side-drops-third',
    klass: 'логика правила: потеряно измерение',
    file: 'src/tariffs.ts',
    tasks: ['oversize', 'freeship'],
    what: '`longestSide` считает максимум по двум сторонам из трёх — негабарит по третьей стороне не определяется',
    find: '  return Math.max(dimensions[0], dimensions[1], dimensions[2]);',
    replace: '  return Math.max(dimensions[0], dimensions[1]);',
    expected: 'review',
    gates: [],
    mentions: [/longestSide/i, /наибольш\w+ сторон/i, /dimensions\[2\]/, /треть\w+ сторон/i],
  },
  {
    id: 'dimension-sum-drops-third',
    klass: 'логика правила: потеряно измерение',
    file: 'src/tariffs.ts',
    tasks: ['oversize', 'freeship'],
    what: '`dimensionSum` складывает два измерения из трёх — порог «сумма больше 300 см» считается не по обхвату',
    find: '  return dimensions[0] + dimensions[1] + dimensions[2];',
    replace: '  return dimensions[0] + dimensions[1];',
    expected: 'review',
    gates: [],
    mentions: [/dimensionSum/i, /сумм\w+ (?:трёх|трех) измерени/i, /dimensions\[2\]/, /обхват/i],
  },
  {
    id: 'weight-step-off-by-one',
    klass: 'off-by-one на границе (контроль стенда)',
    file: 'src/tariffs.ts',
    tasks: ['oversize', 'freeship'],
    what: '`weightStep` делает границы ступеней исключающими: ровно 500 г уезжает на следующую ступень',
    find: '    if (weightG <= limit) return i;',
    replace: '    if (weightG < limit) return i;',
    expected: 'gate',
    gates: ['Тесты'],
    mentions: [/weightStep/i, /границ\w+ ступен/i, /включающ/i, /500/],
  },
  {
    id: 'skip-existing-test',
    klass: 'отключённый ассерт (контроль стенда)',
    file: 'test/tariffs.test.ts',
    tasks: ['oversize', 'freeship'],
    what: 'существующий набор «весовые ступени» отключён через `describe.skip` — тест-гейт обойдён',
    find: "describe('весовые ступени', () => {",
    replace: "describe.skip('весовые ступени', () => {",
    expected: 'gate',
    gates: ['Анти-обход тест-гейта'],
    mentions: [/\.skip/i, /отключ\w+ тест/i, /весовые ступени/i, /анти-обход/i],
  },
];

export function seedIds(): string[] {
  return [SEED_NONE, ...SEEDS.map((s) => s.id)];
}

export function seedById(id: string): SeedDef {
  const s = SEEDS.find((x) => x.id === id);
  if (s === undefined) throw new SeedError(`неизвестный посев «${id}»; допустимы: ${seedIds().join(', ')}`);
  return s;
}

/**
 * Вносит посев в рабочую копию.
 *
 * Любое несовпадение — исключение, а не тихий пропуск: прогон без внесённого дефекта
 * выглядел бы как «рецензент ничего не нашёл», то есть замер, обратный истине. По той же
 * причине требуется РОВНО одно вхождение: два места замены означают, что якорь перестал
 * быть точечным, и что именно посеяно — неизвестно.
 */
export function applySeed(root: string, seed: SeedDef): void {
  const file = join(root, seed.file);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new SeedError(`посев «${seed.id}»: файла ${seed.file} нет в рабочей копии`);
  }

  const parts = text.split(seed.find);
  if (parts.length === 1) {
    throw new SeedError(
      `посев «${seed.id}»: якорь не найден в ${seed.file}. Фикстура изменилась либо снимок ` +
        `снят с другой задачи — посев обязан вноситься в известный текст, а не «куда попало»`,
    );
  }
  if (parts.length > 2) {
    throw new SeedError(
      `посев «${seed.id}»: якорь встречается ${parts.length - 1} раза в ${seed.file} — ` +
        `неоднозначная замена, посев не вносится`,
    );
  }

  writeFileSync(file, parts.join(seed.replace), 'utf8');
}

export interface SeedProbe {
  seedId: string;
  klass: string;
  expected: SeedDef['expected'] | null;
  /** Назван ли посеянный дефект хоть одним из источников вердикта. */
  caught: boolean;
  /** Чем пойман: автоматикой, отчётом рецензента, обоими. */
  where: ('gate' | 'report')[];
  /** Строка для отчёта — человеку, без расшифровки регулярок. */
  note: string;
}

/**
 * Поймал ли этап 6 посеянный дефект.
 *
 * Два независимых источника, оба — уже посчитанные факты прогона, а не новое суждение:
 * красный гейт фактического прогона рантайма и упоминание места дефекта в отчёте приёмки
 * (включая причины вердикта, куда попадают находки ревью). Совпадение по МЕСТУ, а не по
 * оценке: рецензент вправе назвать дефект своими словами.
 */
export function probeSeed(args: {
  seed: SeedDef;
  reportText: string;
  verdictReasons: readonly string[] | null;
  gateResults: readonly GateRunResult[];
}): SeedProbe {
  const { seed } = args;
  const haystack = [args.reportText, ...(args.verdictReasons ?? [])].join('\n');
  const named = seed.mentions.some((re) => re.test(haystack));
  const watched = new Set(seed.gates.map(gateKey));
  const gateRed = args.gateResults.some((g) => g.status === '❌' && watched.has(gateKey(g.name)));

  const where: ('gate' | 'report')[] = [];
  if (gateRed) where.push('gate');
  if (named) where.push('report');

  return {
    seedId: seed.id,
    klass: seed.klass,
    expected: seed.expected,
    caught: where.length > 0,
    where,
    note:
      where.length === 0
        ? `посев «${seed.id}» НЕ назван: ${seed.what}`
        : `посев «${seed.id}» назван (${where.join(', ')}): ${seed.what}`,
  };
}

/**
 * Контрольный прогон без посева: рецензент, «находящий» дефекты в чистом сэмпле, бесполезен
 * ровно так же, как слепой. Здесь `caught` означает ЛОЖНОЕ срабатывание.
 */
export function probeNoSeed(args: {
  verdictReasons: readonly string[] | null;
  gateResults: readonly GateRunResult[];
}): SeedProbe {
  const gateRed = args.gateResults.some((g) => g.status === '❌');
  const findings = (args.verdictReasons ?? []).filter((r) => /расхождени|регресси|инвариант/i.test(r));
  const where: ('gate' | 'report')[] = [];
  if (gateRed) where.push('gate');
  if (findings.length > 0) where.push('report');

  return {
    seedId: SEED_NONE,
    klass: 'без посева — проверка ложных срабатываний',
    expected: null,
    caught: where.length > 0,
    where,
    note:
      where.length === 0
        ? 'без посева: ложных срабатываний нет'
        : `без посева ЕСТЬ срабатывания (${where.join(', ')}): ${[...findings].join('; ') || 'красный гейт'}`,
  };
}
