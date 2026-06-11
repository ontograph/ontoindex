# Почему grep больше не хватает AI-агентам: граф кода как safety layer

`grep` и `ripgrep` отлично отвечают на вопрос:

> Где в проекте встречается эта строка?

Но AI-агенту, который сам меняет код, этого уже мало.

Перед изменением функции агенту нужно понять не только "где она лежит", но и:

- кто ее вызывает;
- какие execution flows она затрагивает;
- какие тесты должны быть запущены;
- не устарел ли индекс;
- не смотрит ли MCP в другой репозиторий;
- не вылез ли итоговый diff за границы задачи.

Иначе агент может звучать уверенно, но работать без доказательств.

## Проблема: search не равен evidence

Обычный workflow AI-агента часто выглядит так:

```text
search -> edit -> maybe run one test -> explain confidently
```

Например, агент получает задачу:

> Измени обработку аргументов CLI.

Он делает:

```bash
rg "parseArgs"
```

Находит несколько файлов, выбирает подходящий, меняет код и пишет:

> Я обновил обработку аргументов, теперь поведение корректное.

Проблема в том, что `rg` не знает:

- это именно тот symbol или просто совпадение текста;
- сколько у функции callers;
- есть ли downstream flows;
- какие тесты связаны с этим кодом;
- какие файлы изменились случайно;
- свежий ли вообще контекст, по которому агент рассуждает.

`grep` отвечает "где текст".
Граф кода отвечает "что зависит от этой сущности".

## Еще хуже: агент может смотреть не в тот репозиторий

Одна из самых неприятных ошибок в MCP-интеграциях выглядит очень скучно.

Есть два репозитория:

```text
/opt/work/OntoIndex      # репозиторий инструмента
/opt/work/product-app    # проект, который надо менять
```

MCP-сервис случайно настроен так:

```text
cwd = /opt/work/OntoIndex
ONTOINDEX_MCP_REPO = /opt/work/OntoIndex
```

А пользователь работает в:

```text
/opt/work/product-app
```

Что происходит дальше:

- symbol lookup не находит функции из `product-app`;
- diff-аудит показывает changed files из `OntoIndex`;
- docs context относится к другому проекту;
- агент все равно отвечает уверенно.

Это не "галлюцинация модели" в классическом смысле.
Это инфраструктурная ошибка контекста.

Если агенту дать неправильный граф, он будет строить разумные выводы из неправильных данных.

## Что должен проверять safety layer

Перед тем как агент правит код, ему полезно пройти цепочку:

```text
repo freshness
  -> exact symbol
  -> impact
  -> edit
  -> diff verification
  -> test evidence
  -> pre-commit audit
```

То есть агент должен уметь ответить:

1. Я точно смотрю в нужный репозиторий?
2. Индекс соответствует текущему commit?
3. Я нашел именно тот symbol, а не похожее имя?
4. Кто зависит от этого symbol?
5. Какие execution flows могут измениться?
6. Какие файлы и symbols реально изменились после edit?
7. Какие тесты подтверждают изменение?
8. Можно ли это коммитить?

Именно эту роль может играть локальный code graph.

## Что такое OntoIndex

OntoIndex - это локальный граф кода для AI-агентов.

Он индексирует репозиторий в `.ontoindex/`, строит связи между файлами, символами, вызовами, маршрутами, тестами и документацией, а затем отдает этот граф через CLI, HTTP API и MCP.

Минимальный запуск:

```bash
npm install -g https://github.com/ontograph/ontoindex/releases/download/v1.9.3/ontoindex-1.9.3.tgz

cd /path/to/repo
ontoindex analyze
ontoindex setup
```

После этого Codex, Claude Code, Cursor или другой MCP-клиент могут обращаться к локальному графу.

## Что попадает в граф

Упрощенно:

```text
File
Function
Class
Method
Route
Test
Requirement
Process
```

И связи:

```text
CALLS
IMPORTS
DEFINES
REFERENCES
TESTS
IMPLEMENTS
PARTICIPATES_IN
```

Это позволяет задавать не только текстовые вопросы, но и структурные:

- кто вызывает эту функцию;
- какие routes зависят от этого handler;
- какие tests связаны с этим symbol;
- какие execution flows пересекаются с изменением;
- какие docs claims могут устареть.

## Safety workflow через MCP

Вместо "нашел и поменял" агент может работать так:

```text
gn_ensure_fresh
   ↓
gn_safe_edit_check
   ↓
gn_find_related / inspect
   ↓
edit
   ↓
gn_verify_diff
   ↓
gn_test_gap
   ↓
gn_pre_commit_audit
```

Разберем по шагам.

### 1. Проверить свежесть графа

```json
{
  "tool": "gn_ensure_fresh",
  "arguments": {
    "repo": "/path/to/repo",
    "autoAnalyze": false
  }
}
```

Идея простая: если индекс был построен на старом commit, agent должен это знать до начала работы.

Хороший ответ должен явно говорить:

```json
{
  "indexedCommit": "abc123",
  "currentCommit": "abc123",
  "isStale": false
}
```

Если `isStale = true`, все дальнейшие рассуждения становятся подозрительными.

### 2. Проверить риск изменения symbol

```json
{
  "tool": "gn_safe_edit_check",
  "arguments": {
    "symbol": "parseWorkerMessage",
    "intent": "modify-body"
  }
}
```

Пример ответа:

```json
{
  "verdict": "CAUTION",
  "directCallers": 6,
  "affectedFlows": 3,
  "risk": "MEDIUM",
  "suggestedTests": [
    "parse-worker.test.ts"
  ]
}
```

Это не запрещает правку.
Но меняет поведение агента: теперь он знает, что функция не изолированная.

## Почему это отличается от grep

`rg parseWorkerMessage` может показать:

```text
src/core/ingestion/workers/parse-worker.ts
test/unit/parse-worker.test.ts
```

Но он не скажет:

```text
- this symbol is used by 6 callers
- it participates in 3 flows
- this edit is medium risk
- run these tests
- do not touch unrelated files
```

Граф не заменяет поиск.
Он добавляет слой отношений и проверок.

## После изменения: проверить diff

Предположим, агент изменил код.

Теперь важно проверить не только "тесты прошли", но и "агент не вышел за границы задачи".

```json
{
  "tool": "gn_verify_diff",
  "arguments": {
    "expectedFiles": [
      "src/core/ingestion/workers/parse-worker.ts"
    ],
    "expectedSymbols": [
      "parseWorkerMessage"
    ],
    "executedTests": [
      "npm run test:unit -- parse-worker"
    ]
  }
}
```

Желаемый ответ:

```json
{
  "status": "PASS",
  "unexpectedFiles": [],
  "unexpectedSymbols": [],
  "missingTests": []
}
```

Если агент случайно изменил соседний модуль, это должно всплыть до commit.

## Проверить тестовое покрытие

```json
{
  "tool": "gn_test_gap",
  "arguments": {
    "changedSymbols": [
      "parseWorkerMessage"
    ],
    "executedTests": [
      "npm run test:unit -- parse-worker"
    ]
  }
}
```

Цель не в том, чтобы магически доказать correctness.
Цель - заставить агента явно связать изменение и test evidence.

## Последний gate: pre-commit audit

Перед commit:

```json
{
  "tool": "gn_pre_commit_audit",
  "arguments": {
    "scope": "staged"
  }
}
```

Пример результата:

```json
{
  "verdict": "READY",
  "reasoning": "All changed files have LOW/MEDIUM risk symbols. No unexpected symbols. Coverage held."
}
```

Или:

```json
{
  "verdict": "DO-NOT-COMMIT",
  "reasoning": "Unexpected high-risk symbol changed without test evidence."
}
```

Это уже ближе к инженерному процессу, а не к "модель сказала, что все нормально".

## Repo guard: защита от неправильного проекта

Для MCP особенно важно явно указывать target repo.

Например:

```bash
ONTOINDEX_MCP_PROJECT_CWD=/path/to/target/repo \
ONTOINDEX_MCP_REPO=/path/to/target/repo \
ontoindex mcp
```

И каждый важный ответ должен показывать, к какому repo он относится:

```json
{
  "repoPath": "/path/to/target/repo",
  "indexedCommit": "abc123",
  "currentCommit": "abc123"
}
```

Если пользователь работает в одном проекте, а MCP отвечает по другому, это должно быть не silent mismatch, а loud failure.

## Где здесь другие инструменты

Эта область быстро развивается, и разные проекты решают разные задачи.

Коротко:

| Tool | Когда выбирать |
| --- | --- |
| Graphify | Если нужен широкий project knowledge graph по коду, docs, PDF, изображениям, видео и отчетам |
| Serena | Если нужны IDE-like symbolic operations: find references, edit symbol, project memories |
| Graphiti MCP | Если нужна temporal memory по фактам и событиям, а не source-code impact |
| CodeGPT Deep Graph MCP | Если граф уже живет в CodeGPT/DeepGraph и нужен hosted доступ |
| OntoIndex | Если нужен локальный code graph как safety layer перед edit/commit/release |

Ключевое отличие OntoIndex не в том, что он "ищет код".
Ищут код многие.

Идея в другом: дать агенту локальные проверяемые gates перед изменением и commit.

## Что это меняет в поведении агента

Без графа:

```text
I found the file and changed it.
```

С графом:

```text
I verified repo freshness.
I resolved the exact symbol.
I checked callers and flows.
I changed only expected files.
I ran relevant tests.
Pre-commit audit is READY.
```

Это принципиально другой уровень ответственности.

## Ограничения

Граф кода не делает AI-агента идеальным.

Он не доказывает полную correctness.
Он может быть устаревшим.
Он зависит от качества parser/extractor.
Он не заменяет тесты и review.

Но он делает важную вещь: превращает часть рассуждений агента в проверяемые факты.

## Вывод

AI coding agents не станут безопасными только потому, что модели станут увереннее.

Уверенность модели - не evidence.

Более безопасный путь - заставить агента проверять свою работу:

- в каком репозитории он находится;
- какой symbol он меняет;
- кто зависит от этого symbol;
- какие files/symbols реально изменились;
- какие tests подтверждают изменение;
- можно ли это коммитить.

Локальный граф кода не заменяет инженера.
Но он дает AI-агенту то, чего у него обычно нет: возможность проверить себя до commit.
