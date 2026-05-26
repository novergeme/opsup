# OpenWebUI Tool Installation

This folder contains the OpenWebUI Tool that connects a chat model to the OpsUp SuperDoc service.

## Files

- `superdoc_tool.py` - install this in OpenWebUI `Workspace -> Tools`.
- `tool-import.json` - generated import payload for API-based installs.

## Install Through UI

1. Start the Docker stack with `./start.sh`.
2. Open `http://localhost:3000`.
3. Go to `Workspace -> Tools -> Create Tool`.
4. Paste the full content of `superdoc_tool.py`.
5. Save the tool and enable it for the model/chat.

## Install Through API

OpenWebUI versions differ in their tool import endpoints. If your instance supports `/api/v1/tools/create`, you can use:

```bash
API_TOKEN="<openwebui_api_token>"

curl -X POST http://localhost:3000/api/v1/tools/create \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @openwebui-integration/tool-import.json
```

If that fails, use the UI install path above.

## Tool Runtime URLs

When OpenWebUI runs in this repository's Docker Compose network, the tool uses:

```text
SUPERDOC_API_URL=http://superdoc:8081
SUPERDOC_API_PUBLIC_URL=http://localhost:8081
```

For an existing external OpenWebUI container, set the tool valves manually:

```text
SUPERDOC_API_INTERNAL_URL=http://host.docker.internal:8081
SUPERDOC_API_PUBLIC_URL=http://localhost:8081
```

On Linux, `host.docker.internal` may require Docker's `host-gateway` mapping or a direct network route.

## Expected Model Workflow

The model should use the tool like this:

1. Uploaded DOCX: call `open_attached_document` first.
2. Large document: call `get_document_text` and/or `search_document_text`.
3. Targeted edit: call `apply_document_actions` with exact `find` strings.
4. Full rewrite: call `edit_document` with final HTML.
5. New document: draft final HTML, then call `create_document`.
6. Return the `assistant_reply` from the tool so OpenWebUI can render the SuperDoc Artifact.

The tool and service keep a persistent document context index, so follow-up requests in the same chat can resolve the active document without relying on OpenWebUI memory or embeddings.
