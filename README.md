# OpsUp

Минимальный монорепозиторий для связки:
- `OpenWebUI` (чат и вызов tool-функций)
- `SuperDoc v2` (DOCX backend + viewer)
- `MCP server` (интеграционные API-инструменты)

В репозитории оставлены только рабочие компоненты без legacy-веток.

## Структура

```text
opsup/
├── docker-compose.yml
├── .env.example
├── start.sh
├── stop.sh
├── mcp-server/
├── superdoc-v2/
└── openwebui-integration/
    ├── superdoc_tool.py
    ├── tool-import.json
    └── README.md
```

## Быстрый старт

1. Подготовить переменные окружения:
```bash
cp .env.example .env
```

2. Запустить стек:
```bash
./start.sh
```

3. Проверить сервисы:
- OpenWebUI: `http://localhost:3000`
- SuperDoc API: `http://localhost:8081/health`
- MCP Server: `http://localhost:8082/mcp/tools`

## Что важно передать разработчику

- Основной backend документа: `superdoc-v2/server.js`
- Интеграционный tool для OpenWebUI: `openwebui-integration/superdoc_tool.py`
- MCP bridge: `mcp-server/server.js`
- Единая сборка/запуск: `docker-compose.yml`

## Ежедневные команды

Запуск:
```bash
./start.sh
```

Остановка:
```bash
./stop.sh
```

Пересборка конкретных сервисов:
```bash
docker compose up -d --build superdoc mcp-server
docker restart opsup-openwebui
```

## Лицензия

См. `LICENSE`.
