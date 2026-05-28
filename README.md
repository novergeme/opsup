# OpsUp SuperDoc for OpenWebUI

First public alpha of an OpenWebUI AI Tool that opens, creates, and edits `.docx` documents with [SuperDoc](https://github.com/superdoc-dev/superdoc).

The goal is simple: a user can upload a Word document in OpenWebUI or ask the model to create one, then continue editing it in a SuperDoc Artifact. AI edits are written back into the DOCX with SuperDoc Track Changes, so additions and deletions stay reviewable.

Watch the video review:

https://github.com/user-attachments/assets/853d5c21-19c0-4044-bf19-89366e6dc34d






## Status

This is an alpha release. It is meant to be usable and understandable, not perfect. The core flow is stable enough to test:

- Upload a `.docx` in OpenWebUI and open it in a SuperDoc Artifact.
- Ask the OpenWebUI model to create a new document from scratch.
- Ask for follow-up edits in the same chat.
- Review AI edits in SuperDoc with Track Changes.
- Save, accept all, reject all, or download from the viewer.

## Architecture

```text
OpenWebUI chat + main LLM
  -> openwebui-integration/superdoc_tool.py
  -> SuperDoc service on :8081
  -> DOCX files + context-index.json in Docker volume
  -> SuperDoc viewer embedded as an OpenWebUI Artifact
```

Important design choice: SuperDoc does not call a second LLM. The model selected in OpenWebUI plans the document content or structured edits. The SuperDoc service only stores documents, extracts text, searches, applies deterministic patches, and renders the editor.

## What Is Included

- `openwebui-integration/superdoc_tool.py` - the OpenWebUI Tool users install in Workspace -> Tools.
- `superdoc-v2/server.js` - deterministic document service and SuperDoc viewer host.
- `superdoc-v2/frontend-src/` - React source for the bundled SuperDoc viewer.
- `mcp-server/` - optional HTTP bridge for external tooling.
- `AGENTS.md` - setup notes for AI coding assistants.

## Requirements

- Docker and Docker Compose
- OpenWebUI model provider configured by OpenWebUI itself
- A model with reliable tool calling
- Modern browser with iframe support

Tested primarily on macOS with Docker. The compose setup targets Linux containers and should work on Linux hosts. Windows users should run it from WSL2 or adapt paths manually.

## Quick Start

1. Clone and configure:

```bash
git clone https://github.com/novergeme/opsup.git
cd opsup
cp .env.example .env
```

2. Edit `.env`:

```env
WEBUI_SECRET_KEY=replace-with-random-secret
OPENAI_API_KEY=your-key-if-using-openai-compatible-provider
OPENAI_API_BASE_URL=https://api.openai.com/v1
```

3. Start services:

```bash
./start.sh
```

4. Open OpenWebUI:

```text
http://localhost:3000
```

5. Install the tool:

- Go to `Workspace -> Tools -> Create Tool`.
- Paste the full content of `openwebui-integration/superdoc_tool.py`.
- Save and enable it for your model/chat.

## Usage Examples

Create a document:

```text
Create a one-page employment agreement for a designer. Open it in SuperDoc.
```

Open an uploaded document:

```text
Open this DOCX in SuperDoc and summarize what is inside.
```

Apply targeted edits:

```text
Replace the payment term with net 15 days and add a confidentiality clause at the end.
```

Continue editing later in the same chat:

```text
Now make the confidentiality clause stricter.
```

If multiple documents exist in one chat, ask the model to list them first:

```text
List the SuperDoc documents in this chat and edit the second one.
```

## Document Memory

OpenWebUI memory/RAG is not used to remember documents. OpsUp stores explicit bindings in the SuperDoc service:

- `chat_id -> active_document_id`
- `file_id -> document_id`
- document history per chat

The index is stored as `context-index.json` in the Docker `documents` volume. If a new `.docx` is uploaded, that file gets its own SuperDoc document and becomes active for that chat. If no new file is attached, follow-up edits use the current active document.

## Track Changes

The viewer runs SuperDoc in suggesting mode. AI patches are exported with native DOCX tracked changes, so Microsoft Word and SuperDoc can review them.

The backend returns final text to the model for follow-up reasoning, while keeping the real DOCX with unresolved Track Changes for the user. This avoids confusing the model with deleted red text during later edits.

## SuperDoc Version

This release updates the `superdoc` package to `1.35.0`.

Relevant upstream docs:

- SuperDoc quick start: https://github.com/superdoc-dev/superdoc/blob/main/apps/docs/getting-started/quickstart.mdx
- Track Changes: https://github.com/superdoc-dev/superdoc/blob/main/apps/docs/editor/built-in-ui/track-changes.mdx
- AI tools / agents: https://github.com/superdoc-dev/superdoc/blob/main/apps/docs/ai/agents/llm-tools.mdx

## Limitations

- This is not production security hardening. The SuperDoc service is intended for trusted local/LAN use unless you add auth and network controls.
- Very complex formatting can still be imperfect after headless edits.
- The Artifact auto-open depends on OpenWebUI rendering an HTML code block. A direct link is always returned as a fallback.
- Real-time collaborative editing is not enabled in this alpha.
- The optional HTTP bridge is not required for the OpenWebUI Tool flow.

## Development

Run syntax checks:

```bash
node --check superdoc-v2/server.js
node --check mcp-server/server.js
python3 -m py_compile openwebui-integration/superdoc_tool.py
```

Build the viewer:

```bash
cd superdoc-v2/frontend-src
npm install
npm run build
```

Rebuild Docker services:

```bash
docker compose up -d --build superdoc mcp-server
```

## License

See `LICENSE`. SuperDoc itself is AGPL-3.0 with commercial licensing available from the SuperDoc project.
