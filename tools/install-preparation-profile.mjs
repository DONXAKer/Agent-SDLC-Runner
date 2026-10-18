/** Устанавливает профиль v2 в эталон, сохраняя тексты этапов v1. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
if (!target) throw new Error('Укажи каталог эталона Agent-SDLC');
const root = resolve(target);
const canon = join(root, 'SDLC.md');
if (!existsSync(canon)) throw new Error('В каталоге нет SDLC.md');
const source = fileURLToPath(new URL('../server/methodology/preparation-v2.md', import.meta.url));
const destination = join(root, 'profiles', 'preparation-v2.md');
const profile = readFileSync(source, 'utf8');
mkdirSync(join(root, 'profiles'), { recursive: true });
if (existsSync(destination) && readFileSync(destination, 'utf8') !== profile) {
  throw new Error('Профиль уже существует и отличается. Сверь его перед заменой: ' + destination);
}
copyFileSync(source, destination);
const marker = '<!-- preparation-v2-runner -->';
const text = readFileSync(canon, 'utf8');
if (!text.includes(marker)) writeFileSync(canon, text.trimEnd() + '\n\n' + marker + `
## Проработка v2 в Agent-SDLC Runner

Для новых витков Runner применяется [профиль проработки v2](profiles/preparation-v2.md):
ИИ готовит требования и приёмку, человек подтверждает их вместе с планом.
Исследование допускает вопросы к реализации; перед реализацией нужны сценарии с основаниями
и контрпримерами, независимая проверка и одобрение конкретной редакции.
История и подтверждения хранятся в preparation.json рядом с intent.md и коммитятся вместе с витком.
Файл пишет только рантайм. Старые витки без preparation.json и терминальные скиллы v1
продолжают работать по прежним правилам; автоматической миграции нет. Виток v2 следует
продолжать в Runner, чтобы сохранить проверки редакций и независимую критику плана.
`, 'utf8');
console.log('Профиль установлен: ' + destination);
