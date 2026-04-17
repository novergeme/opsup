# OpenWebUI Integration

В этой папке оставлены только активные файлы интеграции OpenWebUI <-> SuperDoc.

## Файлы

- `superdoc_tool.py`  
  Основной OpenWebUI Tool для операций с документами через SuperDoc API.

- `tool-import.json`  
  JSON для импорта tool через OpenWebUI API.

## Установка tool в OpenWebUI

Через UI:
1. `Workspace -> Tools -> Create Tool`
2. Вставить код из `superdoc_tool.py`
3. Сохранить и включить tool

Через API:
```bash
API_TOKEN="<openwebui_api_token>"

curl -X POST http://localhost:3000/api/v1/tools/create \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @openwebui-integration/tool-import.json
```

## Ключевые env-переменные

См. `.env.example`:
- `SUPERDOC_API_INTERNAL_URL`
- `SUPERDOC_API_PUBLIC_URL`
- `SUPERDOC_REQUEST_TIMEOUT_SECONDS`
- `SUPERDOC_ENABLE_ARTIFACT_EMBED`
- `SUPERDOC_ARTIFACT_IFRAME_HEIGHT_PX`

## Базовая проверка

1. Открыть OpenWebUI: `http://localhost:3000`
2. В чате отправить: `Create a simple document`
3. Проверить, что в ответе есть ссылка `viewer/index.html?docId=...`
