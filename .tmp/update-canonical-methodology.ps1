$ErrorActionPreference = 'Stop'
$root = 'D:\Проекты\agent-sdlc'

function Write-Utf8NoBom([string]$path, [string]$text) {
  $text = $text.TrimEnd([char]13, [char]10) + "`r`n"
  [System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))
}

$path = Join-Path $root 'SDLC.md'
$text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
$text = [regex]::Replace(
  $text,
  '(?s)\*\*Ревью\*\* ведёт другой агент, \*\*на более сильной модели\*\*, чем исполнитель\..*?на трёх вещах:',
  '**Ревью** ведёт другой агент. Пригодность модели определяется результатами проверок и диагностик, а не рангом. Модель исполнителя — поле свидетельств попытки: под раннером его пишет рантайм (факт), в интерактивной сессии — сам исполнитель при снятии свидетельств (самоотчёт, и источник записывается рядом). Этап 6 сохраняет источник сведений об исполнителе как контекст для анализа результатов. Самоотчёт или отсутствие записи помечаются явно, но не меняют статус проверки. Ранг сам по себе не доказывает пригодность модели.' + "`r`n`r`nНезависимость держится на трёх вещах:"
)
$text = $text.Replace('рецензент — другой агент, на более сильной модели, без рассказа исполнителя; углы фиксированы', 'рецензент — другой агент, без рассказа исполнителя; углы фиксированы')
Write-Utf8NoBom $path $text

$path = Join-Path $root 'implementations/claude-code/skills/sdlc-verify/SKILL.md'
$text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
$text = $text.Replace('без рассказа исполнителя, на более сильной модели — опровергнуть', 'без рассказа исполнителя, с независимой оценкой по артефактам — опровергнуть')
$text = [regex]::Replace(
  $text,
  '(?s)Запусти агента `sdlc-reviewer`.*?(?=На вход дай \*\*ровно)',
  'Запусти агента `sdlc-reviewer` (Agent tool, `subagent_type: sdlc-reviewer`; если тип недоступен —' + "`r`n" + '`general-purpose` с явной инструкцией играть эту роль и её ограничения). Рецензент должен быть' + "`r`n" + 'другим агентом и получать только артефакты, перечисленные ниже; его пригодность оценивается по' + "`r`n" + 'результатам проверок и диагностик. Ранг, семейство модели и её позиция в `model_order` не задают' + "`r`n" + 'статус ревью. Источник сведений об исполнителе записывай явно, если он доступен, как контекст.'
)
Write-Utf8NoBom $path $text

$path = Join-Path $root 'implementations/claude-code/README.md'
$text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
$text = [regex]::Replace($text, '(?s)\*\*«более сильная модель»\*\* у рецензента зафиксирована как `model: opus` — если исполнитель сам\s+работает на opus или сильнее, превосходство модели не гарантируется\.', 'Ранг модели рецензента не является требованием; используйте результаты независимых проверок и диагностик.')
Write-Utf8NoBom $path $text

# `templates/` is the canonical source; the skill copy must match it.
Copy-Item -LiteralPath (Join-Path $root 'templates/plan.template.md') -Destination (Join-Path $root 'implementations/claude-code/skills/sdlc-plan/templates/plan.template.md') -Force

# Keep readable paragraph boundaries when the preceding update is re-applied.
$path = Join-Path $root 'implementations/claude-code/skills/sdlc-verify/SKILL.md'
$text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
$text = $text.Replace('как контекст.На вход дай', 'как контекст.' + "`r`n" + 'На вход дай')
Write-Utf8NoBom $path $text

$path = Join-Path $root 'SDLC.md'
$text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
$text = $text.Replace('Reviewer quality is assessed from independent evidence; model rank neither proves quality nor restricts model selection.', 'Пригодность модели оценивается по независимым свидетельствам; ранг не доказывает качество и не ограничивает выбор модели.')
$needle = '**Проверка:** гейты стоят на выходе, на этапе 6.'
$replacement = '**Контекст шага:** передавай исполнителю карточку текущего шага, его зависимости и относящиеся к ним факты человека; подбирай только нужный фрагмент кода и соседний пример в пределах бюджета контекста.' + "`r`n`r`n" + '**Проверка шага:** сразу после правки проверь результат. В интерактивной реализации выполни команду из карточки; Runner использует включённые доверенные гейты сборки и тестов, а произвольную команду модели не исполняет. Красный результат ремонтируется в пределах бюджета, пропуск из-за среды или отсутствие проверки отмечается `⏭`, а подписанная неприменимость требует имени и даты. Шаги `⏭`/`❌` не засчитываются; chunk останавливается, если нет ни одного проверенного шага. Этап 6 повторно запускает полный набор гейтов после успешного chunk.' + "`r`n`r`n" + '**Проверка:** гейты стоят на выходе, на этапе 6.'
$text = $text.Replace($needle, $replacement)
# Reapplication must collapse the whole section to one canonical copy. The replacement above
# contains the original marker at its end, so a plain .Replace would otherwise duplicate it.
$singleStepInstructions = '**Контекст шага:** передавай исполнителю карточку текущего шага, его зависимости и относящиеся к ним факты человека; подбирай только нужный фрагмент кода и соседний пример в пределах бюджета контекста. Для профиля с `stepFill` Runner включает этот контекст по умолчанию; `stepContext: false` оставляет возможность провести контрольное сравнение.' + "`r`n`r`n" + '**Проверка шага:** сразу после правки проверь результат. В интерактивной реализации выполни команду из карточки; Runner использует включённые доверенные гейты сборки и тестов, а произвольную команду модели не исполняет. Красный результат ремонтируется в пределах бюджета, пропуск из-за среды или отсутствие проверки отмечается `⏭`, а подписанная неприменимость требует имени и даты. Шаги `⏭`/`❌` не засчитываются; chunk останавливается, если нет ни одного проверенного шага. Этап 6 повторно запускает полный набор гейтов после успешного chunk.' + "`r`n`r`n" + '**Проверка:** гейты стоят на выходе, на этапе 6.'
$text = [regex]::Replace($text, '(?s)\*\*Контекст шага:\*\*.*?\*\*Проверка:\*\* гейты стоят на выходе, на этапе 6\.', [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $singleStepInstructions })
Write-Utf8NoBom $path $text

$path = Join-Path $root 'implementations/claude-code/README.md'
$text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
$text = [regex]::Replace($text, '(?s)- \*\*«более сильная модель»\*\* у рецензента .*?превосходство модели не гарантируется\.', 'Ранг модели рецензента не является требованием; используйте результаты независимых проверок и диагностик.')
Write-Utf8NoBom $path $text

$path = Join-Path $root 'implementations/claude-code/skills/sdlc-verify/SKILL.md'
$text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
$text = $text.Replace('как контекст.На вход дай', 'как контекст.' + "`r`n`r`n" + 'На вход дай')
$text = $text.Replace('позиция в `model_order` не задают', 'порядок моделей не задают')
Write-Utf8NoBom $path $text

# Reviewer rank ordering was only used to enforce a false prerequisite; remove its dead constant and consumer.
$path = Join-Path $root 'sdlc-constants.json'
$text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
$text = [regex]::Replace($text, '(?s),?\s*"model_order"\s*:\s*\[\s*"haiku"\s*,\s*"sonnet"\s*,\s*"opus"\s*,\s*"fable"\s*\]', '')
Write-Utf8NoBom $path $text
$path = Join-Path $root 'tools/check-consistency.py'
$text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
$text = [regex]::Replace($text, '(?m)^\s*"model_order": lambda:.*\r?\n', '')
Write-Utf8NoBom $path $text
$path = Join-Path $root 'implementations/claude-code/skills/sdlc-verify/tools/sdlc_common.py'
$text = Get-Content -LiteralPath $path -Raw -Encoding UTF8
$text = [regex]::Replace($text, '(?m)^MODEL_ORDER = .*\r?\n', '')
Write-Utf8NoBom $path $text
Copy-Item -LiteralPath (Join-Path $root 'sdlc-constants.json') -Destination (Join-Path $root 'implementations/claude-code/skills/sdlc-verify/tools/sdlc-constants.json') -Force

git -C $root diff --check




