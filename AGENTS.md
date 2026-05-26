# AI Assistant Setup Guide

Use this file when an AI coding assistant is asked to install or repair OpsUp SuperDoc for OpenWebUI.

## Goal

Install an OpenWebUI Tool plus a SuperDoc document service so users can create, upload, view, and edit `.docx` files in an OpenWebUI Artifact with Track Changes.

## Repository Layout

- `docker-compose.yml` starts OpenWebUI, SuperDoc service, and optional HTTP bridge.
- `openwebui-integration/superdoc_tool.py` is the code to paste into OpenWebUI Workspace -> Tools.
- `superdoc-v2/server.js` stores documents, extracts text, applies patches, and hosts `/viewer`.
- `superdoc-v2/frontend-src/` builds the SuperDoc viewer bundle.
- `superdoc-v2/frontend/` contains the generated viewer assets.

## Install Steps

1. Copy env file:

```bash
cp .env.example .env
```

2. Set at least:

```env
WEBUI_SECRET_KEY=<random-secret>
OPENAI_API_KEY=<provider-key-if-needed>
OPENAI_API_BASE_URL=<openai-compatible-url>
```

3. Start stack:

```bash
./start.sh
```

4. Install OpenWebUI tool:

- Open `http://localhost:3000`.
- Go to `Workspace -> Tools -> Create Tool`.
- Paste `openwebui-integration/superdoc_tool.py`.
- Save and enable it.

## Important Behavior

- Do not add a second LLM call inside SuperDoc. OpenWebUI's selected model is the only model.
- The model should pass final HTML to `create_document` / `edit_document`, not a raw prompt.
- For targeted edits, prefer `search_document_text` then `apply_document_actions`.
- The SuperDoc service stores persistent bindings in `context-index.json` inside the `documents` volume.
- New file attachment means new file context. If a new `.docx` is uploaded, do not silently edit an older active chat document.

## Validation Commands

```bash
node --check superdoc-v2/server.js
node --check mcp-server/server.js
python3 -m py_compile openwebui-integration/superdoc_tool.py
docker compose config --quiet
```

Runtime smoke test without Docker:

```bash
cd superdoc-v2
DOCUMENT_STORAGE_PATH=/tmp/opsup-superdoc-test SUPERDOC_PORT=19081 node server.js
```

Then in another shell:

```bash
curl -s http://127.0.0.1:19081/health
```

## Common Fixes

- If Artifact does not auto-open, ensure the assistant returns the tool's `assistant_reply`, which includes an HTML iframe block.
- If OpenWebUI runs outside the compose stack, set `SUPERDOC_API_INTERNAL_URL` to a URL reachable from that container.
- If formatting color pickers look wrong, avoid broad CSS rules like `.v-binder-follower-content * { color: ... !important; }`; they override SuperDoc color swatches.
- If follow-up edits hit the wrong document, inspect `GET /api/context/documents?chat_id=<chat_id>` and `context-index.json`.
