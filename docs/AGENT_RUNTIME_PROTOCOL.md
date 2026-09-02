# lexsus-agent/1 — протокол Agent Runtime (Фаза 1)

Расширение протокола v2 (`ws://127.0.0.1:45241`). Всё ниже — надстройка над
существующими кадрами pair/tool_call/tool_result/handoff; старые клиенты
продолжают работать.

## Новые кадры

### Задачи (Task entity)

```
ext → app  {"type":"task_create","id":"<req>","title":"…","objective":"…"}
ext → app  {"type":"task_status","id":"<req>","task_id":"task_…"}
ext → app  {"type":"task_pause" |"task_resume"|"task_cancel","id":"<req>","task_id":"task_…"}
app → ext  {"type":"task_result","id":"<req>","ok":true,"task":{…}}
           {"type":"task_result","id":"<req>","ok":false,"error":"illegal transition: …"}
```

Состояния задачи: `created, queued, planning, executing, waiting_approval,
awaiting_input, paused, blocked, retrying, cancelling, cancelled, completed,
failed`. Переходы проверяются таблицей в `task.rs` и пишутся в
`task_state_transitions` — недопустимый переход возвращает ошибку, а не
молча игнорируется.

### Отмена выполнения

```
ext → app  {"type":"cancel","id":"<request-id>"}
app → ext  {"type":"cancel-ok","id":"<request-id>","killed":<число процессов>}
```

Убивает процессы, зарегистрированные за этим request id (реестр процессов,
`process.rs`): SIGTERM группе процессов → SIGKILL через 500 мс. Раньше
`cancel` попадал в catch-all и **разрывал соединение**.

### Поток вывода команды

Пока `run_command` выполняется после одобрения, приложение шлёт:

```
app → ext  {"type":"tool_stream","id":"<request-id>","kind":"start","command":"…"}
app → ext  {"type":"tool_stream","id":"<request-id>","kind":"output","data":"…"}
app → ext  {"type":"tool_stream","id":"<request-id>","kind":"exit","code":0,"timed_out":false,"truncated":false}
```

Расширение рисует их в терминальном виджете в реальном времени.

### Немедленный pending

Как только вызов встаёт в очередь одобрения, приложение сразу шлёт
`{"type":"tool_result","status":"pending",…}`, а финальный результат приходит
после решения пользователя. Расширение НЕ снимает watchdog-таймаут по
`pending` — только по финальному статусу.

### MCP-инструменты

```
ext → app  {"type":"mcp_tools"}
app → ext  {"type":"mcp_tools","tools":[{"server":"macos","name":"click",
           "wire_name":"mcp__macos__click","description":"…","read_only":false}]}
```

Вызов: обычный `tool_call` с `tool:"mcp__macos__click"` (или
`tool:"mcp_call"` с `arguments:{server, tool, args}`). Одобрение:
`read_only:true` (MCP `annotations.readOnlyHint`) → авто; иначе — всегда
спрашивать. MacOS-MCP управляет всем Mac через Accessibility, поэтому «не
объявлено read-only» = опасно.

### Идемпотентность

Повтор `tool_call` с уже исполненным `id` (retry расширения) отклоняется:
`{"code":"DUPLICATE_REQUEST"}`. Сопоставление — по `audit_log.request_id`.

### Прочее

- Неизвестный `type` больше не разрывает соединение — отвечает
  `{"type":"error","error":"unknown frame type: …"}`.
- Кадр больше 10 МБ отклоняется (`frame too large`).

## Конфигурация MCP

`mcp.json` в каталоге данных приложения (`~/Library/Application Support/
<bundle-id>/mcp.json` на macOS); пример — `mcp.example.json` в корне
репозитория. Серверы стартуют автоматически в фоне при запуске приложения.
