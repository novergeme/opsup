"""
title: SuperDoc Document Editor
author: OpsUp Team
author_url: https://opsup.ai
version: 3.3.2
funding_url: https://opsup.ai
license: Commercial
required_open_webui_version: 0.4.0
"""

import html
import json
import os
import re
import time
from typing import Awaitable, Callable, Optional
from urllib.parse import unquote

import requests
from pydantic import BaseModel, Field

file_handler = True
citation = True

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
FILE_ID_PATTERN = re.compile(r"[a-f0-9-]{36}", re.IGNORECASE)
FILE_URL_PATTERN = re.compile(r"/api/v1/files/([a-f0-9-]{36})/content", re.IGNORECASE)
DOCUMENT_ID_PATTERN = re.compile(r"^[a-f0-9-]{36}$", re.IGNORECASE)


class EventEmitter:
    def __init__(self, event_emitter: Optional[Callable[[dict], Awaitable[None]]] = None):
        self.emit = event_emitter

    async def status(self, description: str, done: bool = False):
        if self.emit:
            await self.emit(
                {
                    "type": "status",
                    "data": {
                        "description": description,
                        "done": done,
                    },
                }
            )

    async def citation(self, name: str, url: str):
        if self.emit:
            await self.emit(
                {
                    "type": "citation",
                    "data": {
                        "document": [name],
                        "metadata": [{"source": name, "url": url}],
                        "source": {"name": name, "url": url},
                    },
                }
            )

    async def execute(self, code: str):
        if self.emit:
            await self.emit(
                {
                    "type": "execute",
                    "data": {"code": code},
                }
            )


class Tools:
    class Valves(BaseModel):
        SUPERDOC_API_INTERNAL_URL: str = Field(
            default="http://host.docker.internal:8081",
            description="SuperDoc API URL reachable from inside the OpenWebUI container",
        )
        SUPERDOC_API_PUBLIC_URL: str = Field(
            default="http://localhost:8081",
            description="Public SuperDoc URL shown to the user in links",
        )
        REQUEST_TIMEOUT_SECONDS: int = Field(
            default=120,
            description="HTTP timeout for SuperDoc API requests",
        )
        ENABLE_ARTIFACT_EMBED: bool = Field(
            default=True,
            description="Append HTML iframe block in assistant_reply to auto-trigger OpenWebUI Artifact",
        )
        ARTIFACT_IFRAME_HEIGHT_PX: int = Field(
            default=920,
            description="Iframe height used in Artifact embed HTML",
        )

    def __init__(self):
        defaults = self.Valves()
        self.valves = self.Valves(
            SUPERDOC_API_INTERNAL_URL=os.environ.get(
                "SUPERDOC_API_INTERNAL_URL",
                os.environ.get("SUPERDOC_API_URL", defaults.SUPERDOC_API_INTERNAL_URL),
            ),
            SUPERDOC_API_PUBLIC_URL=os.environ.get(
                "SUPERDOC_API_PUBLIC_URL",
                os.environ.get("SUPERDOC_PUBLIC_URL", defaults.SUPERDOC_API_PUBLIC_URL),
            ),
            REQUEST_TIMEOUT_SECONDS=int(
                os.environ.get(
                    "SUPERDOC_REQUEST_TIMEOUT_SECONDS",
                    str(defaults.REQUEST_TIMEOUT_SECONDS),
                )
            ),
            ENABLE_ARTIFACT_EMBED=self._to_bool(
                os.environ.get("SUPERDOC_ENABLE_ARTIFACT_EMBED"),
                defaults.ENABLE_ARTIFACT_EMBED,
            ),
            ARTIFACT_IFRAME_HEIGHT_PX=max(
                int(
                    os.environ.get(
                        "SUPERDOC_ARTIFACT_IFRAME_HEIGHT_PX",
                        str(defaults.ARTIFACT_IFRAME_HEIGHT_PX),
                    )
                ),
                320,
            ),
        )

    def _to_bool(self, value, default: bool) -> bool:
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"1", "true", "yes", "on"}

    def _internal_url(self) -> str:
        return self.valves.SUPERDOC_API_INTERNAL_URL.rstrip("/")

    def _public_url(self) -> str:
        return self.valves.SUPERDOC_API_PUBLIC_URL.rstrip("/")

    def _viewer_url(self, document_id: str) -> str:
        public_url = self._public_url()
        return (
            f"{public_url}/viewer/index.html?docId={document_id}"
            f"&api_url={public_url}&docs_api_url={public_url}"
        )

    def _request(self, method: str, path: str, **kwargs):
        response = requests.request(
            method,
            f"{self._internal_url()}{path}",
            timeout=self.valves.REQUEST_TIMEOUT_SECONDS,
            **kwargs,
        )
        response.raise_for_status()
        if not response.content:
            return {}
        return response.json()

    def _artifact_viewer_url(self, viewer_url: str, refresh_token: str = "") -> str:
        separator = "&" if "?" in viewer_url else "?"
        url = f"{viewer_url}{separator}artifact=1&embed=1"
        if refresh_token:
            url = f"{url}&_owui_refresh={refresh_token}"
        return url

    def _artifact_refresh_token(self) -> str:
        return str(int(time.time() * 1000))

    def _artifact_html_block(self, viewer_url: str) -> str:
        if not self.valves.ENABLE_ARTIFACT_EMBED:
            return ""

        iframe_url = html.escape(
            self._artifact_viewer_url(viewer_url, refresh_token=self._artifact_refresh_token()),
            quote=True,
        )
        height = max(int(self.valves.ARTIFACT_IFRAME_HEIGHT_PX), 320)
        return (
            "```html\n"
            f'<iframe src="{iframe_url}" title="SuperDoc Viewer" '
            f'style="width:100%;height:{height}px;border:0;border-radius:10px;" loading="eager"></iframe>\n'
            "```"
        )

    def _artifact_refresh_execute_code(self, viewer_url: str) -> str:
        iframe_src = self._artifact_viewer_url(viewer_url, refresh_token=self._artifact_refresh_token())
        iframe_html = (
            f'<iframe src="{html.escape(iframe_src, quote=True)}" '
            f'title="SuperDoc Viewer" '
            f'style="width:100%;height:{max(int(self.valves.ARTIFACT_IFRAME_HEIGHT_PX), 320)}px;'
            f'border:0;border-radius:10px;" loading="eager"></iframe>'
        )
        return (
            "(() => {"
            "  const artifactFrame = document.querySelector('iframe[title=\"Content\"]');"
            "  if (!artifactFrame) {"
            "    return { updated: false, reason: 'artifact_not_open' };"
            "  }"
            f"  const srcdoc = {json.dumps(iframe_html)};"
            "  artifactFrame.setAttribute('srcdoc', srcdoc);"
            "  return { updated: true, reason: 'artifact_refreshed' };"
            "})();"
        )

    async def _refresh_open_artifact(self, emitter: EventEmitter, viewer_url: str):
        if not self.valves.ENABLE_ARTIFACT_EMBED:
            return
        try:
            await emitter.execute(self._artifact_refresh_execute_code(viewer_url))
        except Exception:
            # Best-effort UI refresh only; document operation itself must not fail because of this.
            return

    def _build_assistant_reply(self, action: str, filename: str, viewer_url: str) -> str:
        summary = f"{action}: {filename}. [Open in SuperDoc Viewer]({viewer_url})"
        artifact_block = self._artifact_html_block(viewer_url)
        if artifact_block:
            return f"{summary}\n\n{artifact_block}"
        return summary

    def _state_file_path(self) -> str:
        return os.environ.get("SUPERDOC_TOOL_STATE_FILE", "/tmp/superdoc_tool_state.json")

    def _load_state(self) -> dict:
        default_state = {"by_chat": {}, "by_file": {}}
        path = self._state_file_path()
        try:
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            if not isinstance(payload, dict):
                return default_state
            by_chat = payload.get("by_chat", {})
            by_file = payload.get("by_file", {})
            return {
                "by_chat": by_chat if isinstance(by_chat, dict) else {},
                "by_file": by_file if isinstance(by_file, dict) else {},
            }
        except Exception:
            return default_state

    def _save_state(self, state: dict):
        path = self._state_file_path()
        try:
            directory = os.path.dirname(path)
            if directory:
                os.makedirs(directory, exist_ok=True)
            temp_path = f"{path}.tmp"
            with open(temp_path, "w", encoding="utf-8") as handle:
                json.dump(state, handle, ensure_ascii=False)
            os.replace(temp_path, path)
        except Exception:
            # State cache is best-effort only.
            return

    def _is_document_id(self, value: str) -> bool:
        return bool(DOCUMENT_ID_PATTERN.fullmatch(str(value or "").strip()))

    def _normalize_file_ids(self, value) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                return []
            if stripped.startswith("["):
                try:
                    return self._normalize_file_ids(json.loads(stripped))
                except Exception:
                    return [stripped] if FILE_ID_PATTERN.fullmatch(stripped) else []
            return [stripped] if FILE_ID_PATTERN.fullmatch(stripped) else []
        if isinstance(value, (list, tuple, set)):
            normalized: list[str] = []
            seen = set()
            for item in value:
                candidate = str(item or "").strip()
                if candidate and FILE_ID_PATTERN.fullmatch(candidate) and candidate not in seen:
                    normalized.append(candidate)
                    seen.add(candidate)
            return normalized
        return []

    def _candidate_file_ids(
        self,
        file_id: str = "",
        __files__=None,
        __chat_id__: Optional[str] = None,
        __message_id__: Optional[str] = None,
    ) -> list[str]:
        candidates: list[str] = []
        if file_id:
            candidates.append(file_id)
        candidates.extend(self._extract_file_ids(__files__ or []))
        candidates.extend(self._chat_file_ids(__chat_id__, __message_id__))
        if __chat_id__:
            candidates.extend(self._chat_file_ids(__chat_id__, None))

        ordered: list[str] = []
        seen = set()
        for item in candidates:
            candidate = str(item or "").strip()
            if not candidate or candidate in seen:
                continue
            if FILE_ID_PATTERN.fullmatch(candidate):
                ordered.append(candidate)
                seen.add(candidate)
        return ordered

    def _operation_file_ids(self, file_id: str = "", __files__=None) -> list[str]:
        candidates: list[str] = []
        if file_id:
            candidates.append(file_id)
        candidates.extend(self._extract_file_ids(__files__ or []))

        ordered: list[str] = []
        seen = set()
        for item in candidates:
            candidate = str(item or "").strip()
            if not candidate or candidate in seen:
                continue
            if FILE_ID_PATTERN.fullmatch(candidate):
                ordered.append(candidate)
                seen.add(candidate)
        return ordered

    def _remember_document_binding(
        self,
        document_id: str,
        __chat_id__: Optional[str] = None,
        file_ids: Optional[list[str]] = None,
    ):
        if not self._is_document_id(document_id):
            return

        state = self._load_state()
        timestamp = int(time.time())
        if __chat_id__:
            state["by_chat"][str(__chat_id__)] = {"document_id": document_id, "updated_at": timestamp}
        for item in file_ids or []:
            candidate = str(item or "").strip()
            if candidate and FILE_ID_PATTERN.fullmatch(candidate):
                state["by_file"][candidate] = {"document_id": document_id, "updated_at": timestamp}
        self._save_state(state)

    def _context_metadata(
        self,
        __chat_id__: Optional[str] = None,
        __message_id__: Optional[str] = None,
        file_ids: Optional[list[str]] = None,
    ) -> dict:
        metadata: dict = {"source": "openwebui-tool"}
        if __chat_id__:
            metadata["openwebui_chat_id"] = __chat_id__
        if __message_id__:
            metadata["openwebui_message_id"] = __message_id__
        normalized_file_ids = self._normalize_file_ids(file_ids or [])
        if normalized_file_ids:
            metadata["openwebui_file_id"] = normalized_file_ids[0]
            metadata["openwebui_file_ids"] = normalized_file_ids
        return metadata

    def _document_metadata(self, document: dict) -> dict:
        metadata = {}
        embedded = (document or {}).get("metadata", {})
        if isinstance(embedded, dict):
            metadata.update(embedded)
        for key in (
            "source",
            "openwebui_chat_id",
            "openwebui_message_id",
            "openwebui_file_id",
            "openwebui_file_ids",
        ):
            value = (document or {}).get(key)
            if value is not None and key not in metadata:
                metadata[key] = value
        return metadata

    def _find_document_by_context(
        self,
        __chat_id__: Optional[str] = None,
        file_ids: Optional[list[str]] = None,
    ) -> str:
        try:
            result = self._request("GET", "/api/documents")
            documents = result.get("documents", [])
        except Exception:
            return ""

        normalized_file_ids = set(self._normalize_file_ids(file_ids or []))
        best_document_id = ""
        best_score = -1
        best_timestamp = ""

        for document in documents:
            document_id = str((document or {}).get("id", "")).strip()
            if not self._is_document_id(document_id):
                continue

            metadata = self._document_metadata(document or {})
            source = str(metadata.get("source", "") or "").strip().lower()
            if source and source != "openwebui-tool":
                continue

            score = 0
            metadata_chat_id = str(metadata.get("openwebui_chat_id", "") or "").strip()
            if __chat_id__ and metadata_chat_id == __chat_id__:
                score = max(score, 2)

            metadata_file_ids = set(self._normalize_file_ids(metadata.get("openwebui_file_ids")))
            metadata_file_id = str(metadata.get("openwebui_file_id", "") or "").strip()
            if metadata_file_id and FILE_ID_PATTERN.fullmatch(metadata_file_id):
                metadata_file_ids.add(metadata_file_id)
            if normalized_file_ids and metadata_file_ids.intersection(normalized_file_ids):
                score = max(score, 3)

            if score <= 0:
                continue

            timestamp = str((document or {}).get("updatedAt") or (document or {}).get("createdAt") or "")
            if score > best_score or (score == best_score and timestamp > best_timestamp):
                best_document_id = document_id
                best_score = score
                best_timestamp = timestamp

        return best_document_id

    def _resolve_document_id(
        self,
        document_id: str = "",
        file_id: str = "",
        __files__=None,
        __chat_id__: Optional[str] = None,
        __message_id__: Optional[str] = None,
    ) -> str:
        explicit = str(document_id or "").strip()
        if self._is_document_id(explicit):
            return explicit

        candidate_file_ids = self._candidate_file_ids(file_id, __files__, __chat_id__, __message_id__)
        state = self._load_state()
        by_file = state.get("by_file", {}) if isinstance(state, dict) else {}
        by_chat = state.get("by_chat", {}) if isinstance(state, dict) else {}

        for candidate in candidate_file_ids:
            entry = by_file.get(candidate, {})
            cached_document_id = str((entry or {}).get("document_id", "")).strip()
            if self._is_document_id(cached_document_id):
                return cached_document_id

        if __chat_id__:
            entry = by_chat.get(str(__chat_id__), {})
            cached_document_id = str((entry or {}).get("document_id", "")).strip()
            if self._is_document_id(cached_document_id):
                return cached_document_id

        resolved_document_id = self._find_document_by_context(__chat_id__, candidate_file_ids)
        if resolved_document_id:
            self._remember_document_binding(resolved_document_id, __chat_id__, candidate_file_ids)
        return resolved_document_id

    def _decode_filename(self, value: str) -> str:
        decoded = unquote(value or "")
        return decoded if decoded else value

    def _preferred_filename(self, file_model) -> str:
        meta = getattr(file_model, "meta", {}) or {}
        return self._decode_filename(meta.get("name") or getattr(file_model, "filename", "document.docx"))

    def _extract_file_ids(self, value) -> list[str]:
        found: list[str] = []

        def visit(node):
            if node is None:
                return
            if isinstance(node, str):
                if FILE_ID_PATTERN.fullmatch(node):
                    found.append(node)
                found.extend(FILE_URL_PATTERN.findall(node))
                for match in re.findall(r"file-([a-f0-9-]{36})", node, flags=re.IGNORECASE):
                    found.append(match)
                return
            if isinstance(node, dict):
                for key in ("id", "file_id"):
                    candidate = node.get(key)
                    if isinstance(candidate, str) and FILE_ID_PATTERN.fullmatch(candidate):
                        found.append(candidate)
                for item in node.values():
                    visit(item)
                return
            if isinstance(node, (list, tuple, set)):
                for item in node:
                    visit(item)

        visit(value)

        ordered: list[str] = []
        seen = set()
        for item in found:
            if item not in seen:
                ordered.append(item)
                seen.add(item)
        return ordered

    def _chat_file_ids(self, chat_id: Optional[str], message_id: Optional[str]) -> list[str]:
        if not chat_id:
            return []

        try:
            from open_webui.internal.db import get_db_context
            from open_webui.models.chats import ChatFile

            with get_db_context() as db:
                query = db.query(ChatFile).filter_by(chat_id=chat_id)
                if message_id:
                    query = query.filter_by(message_id=message_id)
                chat_files = query.order_by(ChatFile.created_at.desc()).all()
                return [item.file_id for item in chat_files if item.file_id]
        except Exception:
            return []

    def _is_docx_file(self, file_model) -> bool:
        filename = (getattr(file_model, "filename", "") or "").lower()
        meta = getattr(file_model, "meta", {}) or {}
        content_type = str(meta.get("content_type", "") or "").lower()
        return filename.endswith(".docx") or content_type == DOCX_MIME

    def _resolve_file_model(
        self,
        file_id: str = "",
        __files__=None,
        __chat_id__: Optional[str] = None,
        __message_id__: Optional[str] = None,
    ):
        from open_webui.models.files import Files

        candidate_ids = self._candidate_file_ids(file_id, __files__, __chat_id__, __message_id__)

        seen = set()
        for candidate_id in candidate_ids:
            if not candidate_id or candidate_id in seen:
                continue
            seen.add(candidate_id)

            file_model = Files.get_file_by_id(candidate_id)
            if file_model and self._is_docx_file(file_model):
                return file_model

        raise ValueError(
            "No DOCX file found in the current chat context. Attach a .docx file or pass file_id explicitly."
        )

    def _upload_to_superdoc(self, file_model, metadata: Optional[dict] = None):
        if not getattr(file_model, "path", None):
            raise ValueError("Attached OpenWebUI file has no local path")

        filename = self._preferred_filename(file_model)
        payload = {"filename": filename}
        if metadata and isinstance(metadata, dict):
            payload["metadata"] = json.dumps(metadata, ensure_ascii=False)
        with open(file_model.path, "rb") as handle:
            response = requests.post(
                f"{self._internal_url()}/api/documents/upload",
                data=payload,
                files={
                    "document": (
                        filename,
                        handle,
                        DOCX_MIME,
                    )
                },
                timeout=self.valves.REQUEST_TIMEOUT_SECONDS,
            )
        response.raise_for_status()
        return response.json()

    async def open_attached_document(
        self,
        file_id: str = "",
        max_chars: int = 16000,
        __files__=None,
        __chat_id__: Optional[str] = None,
        __message_id__: Optional[str] = None,
        __event_emitter__: Callable[[dict], Awaitable[None]] = None,
    ) -> dict:
        """
        Import the currently attached DOCX into SuperDoc and return the extracted text plus the viewer link.
        Use this first when the user uploaded a DOCX and you need a stable `document_id` for later edits.
        The imported document is bound to current chat context for follow-up edits.

        :param file_id: Optional OpenWebUI file UUID if you need a specific attachment
        :param max_chars: Maximum extracted text characters to return (default 16000)
        :return: JSON with document_id, filename, viewer_url, extracted_text
        """
        emitter = EventEmitter(__event_emitter__)
        try:
            try:
                max_chars = max(int(max_chars), 1)
            except (TypeError, ValueError):
                max_chars = 16000
            await emitter.status("Importing DOCX into SuperDoc...")
            candidate_file_ids = self._operation_file_ids(file_id, __files__)
            file_model = self._resolve_file_model(file_id, __files__, __chat_id__, __message_id__)
            if getattr(file_model, "id", None):
                candidate_file_ids.append(str(file_model.id))
            upload_result = self._upload_to_superdoc(
                file_model,
                metadata=self._context_metadata(__chat_id__, __message_id__, candidate_file_ids),
            )
            document = upload_result.get("document", {})
            document_id = document.get("id")
            filename = self._preferred_filename(file_model)
            text_result = self._request("GET", f"/api/documents/{document_id}/text")
            text = str(text_result.get("text", "") or "")
            truncated = len(text) > max_chars
            extracted_text = text[:max_chars]
            viewer_url = self._viewer_url(document_id)
            self._remember_document_binding(document_id, __chat_id__, candidate_file_ids)

            await emitter.citation(filename, viewer_url)
            await emitter.status("Document imported into SuperDoc", done=True)

            return {
                "success": True,
                "document_id": document_id,
                "file_id": file_model.id,
                "filename": filename,
                "viewer_url": viewer_url,
                "extracted_text": extracted_text,
                "truncated": truncated,
                "message": f"Document imported. [Open in SuperDoc Viewer]({viewer_url})",
            }
        except Exception as exc:
            await emitter.status(f"Failed to import document: {exc}", done=True)
            return {"success": False, "error": str(exc)}

    async def get_document_text(
        self,
        document_id: str = "",
        file_id: str = "",
        offset: int = 0,
        max_chars: int = 16000,
        __files__=None,
        __chat_id__: Optional[str] = None,
        __message_id__: Optional[str] = None,
        __event_emitter__: Callable[[dict], Awaitable[None]] = None,
    ) -> dict:
        """
        Get a text window from a SuperDoc document.
        Use this for large files to read the document in chunks before applying action-based edits.
        If `document_id` is empty, tool tries to use active document bound to current chat/file context.

        :param document_id: SuperDoc document UUID
        :param file_id: Optional OpenWebUI file UUID for active-document lookup
        :param offset: Character offset in extracted text (default 0)
        :param max_chars: Maximum text characters to return (default 16000)
        :return: JSON with filename, viewer_url, extracted_text window and pagination info
        """
        emitter = EventEmitter(__event_emitter__)
        try:
            active_document_id = self._resolve_document_id(
                document_id=document_id,
                file_id=file_id,
                __files__=__files__,
                __chat_id__=__chat_id__,
                __message_id__=__message_id__,
            )
            if not active_document_id:
                raise ValueError(
                    "No active SuperDoc document found. Attach a .docx once or pass document_id explicitly."
                )
            try:
                max_chars = max(int(max_chars), 1)
            except (TypeError, ValueError):
                max_chars = 16000
            try:
                offset = max(int(offset), 0)
            except (TypeError, ValueError):
                offset = 0
            await emitter.status("Loading document text from SuperDoc...")
            result = self._request(
                "GET",
                f"/api/documents/{active_document_id}/text",
                params={"offset": offset, "max_chars": max_chars},
            )
            document = result.get("document", {})
            text = str(result.get("text", "") or "")
            viewer_url = self._viewer_url(active_document_id)
            await emitter.status("Document text loaded", done=True)
            return {
                "success": True,
                "document_id": active_document_id,
                "filename": document.get("filename", "document.docx"),
                "viewer_url": viewer_url,
                "extracted_text": text,
                "total_chars": int(result.get("total_chars", len(text))),
                "offset": int(result.get("offset", offset)),
                "max_chars": int(result.get("max_chars", max_chars)),
                "truncated": bool(result.get("truncated", False)),
            }
        except Exception as exc:
            await emitter.status(f"Failed to load document text: {exc}", done=True)
            return {"success": False, "error": str(exc)}

    async def list_documents(
        self,
        limit: int = 10,
        __event_emitter__: Callable[[dict], Awaitable[None]] = None,
    ) -> dict:
        """
        List the most recent SuperDoc documents.
        Use this when you need to recover a `document_id` from previous work in the same workspace.

        :param limit: Maximum number of documents to return (default 10)
        :return: JSON with recent document ids, filenames, and viewer links
        """
        emitter = EventEmitter(__event_emitter__)
        try:
            try:
                limit = max(int(limit), 1)
            except (TypeError, ValueError):
                limit = 10
            await emitter.status("Loading recent SuperDoc documents...")
            result = self._request("GET", "/api/documents")
            documents = result.get("documents", [])[:limit]
            items = [
                {
                    "document_id": item.get("id"),
                    "filename": item.get("filename"),
                    "viewer_url": self._viewer_url(item.get("id")),
                    "updated_at": item.get("updatedAt"),
                }
                for item in documents
            ]
            await emitter.status("Recent documents loaded", done=True)
            return {"success": True, "documents": items, "count": len(items)}
        except Exception as exc:
            await emitter.status(f"Failed to list documents: {exc}", done=True)
            return {"success": False, "error": str(exc)}

    async def search_document_text(
        self,
        document_id: str = "",
        file_id: str = "",
        query: str = "",
        search_query: str = "",
        max_results: int = 20,
        context_chars: int = 200,
        __files__=None,
        __chat_id__: Optional[str] = None,
        __message_id__: Optional[str] = None,
        __event_emitter__: Callable[[dict], Awaitable[None]] = None,
    ) -> dict:
        """
        Search within the extracted text of a SuperDoc document.
        Use this before patching large documents so edits target exact fragments.
        If `document_id` is empty, tool tries to use active document bound to current chat/file context.

        :param document_id: SuperDoc document UUID
        :param file_id: Optional OpenWebUI file UUID for active-document lookup
        :param query: Text query to locate in the document
        :param search_query: Backward-compatible alias for `query`
        :param max_results: Maximum number of matches to return
        :param context_chars: Context size around each match
        :return: JSON with match positions and snippets
        """
        emitter = EventEmitter(__event_emitter__)
        try:
            active_document_id = self._resolve_document_id(
                document_id=document_id,
                file_id=file_id,
                __files__=__files__,
                __chat_id__=__chat_id__,
                __message_id__=__message_id__,
            )
            if not active_document_id:
                raise ValueError(
                    "No active SuperDoc document found. Attach a .docx once or pass document_id explicitly."
                )
            query = str(query or search_query or "").strip()
            if not query:
                raise ValueError("query is required")
            try:
                max_results = max(int(max_results), 1)
            except (TypeError, ValueError):
                max_results = 20
            try:
                context_chars = max(int(context_chars), 0)
            except (TypeError, ValueError):
                context_chars = 200

            await emitter.status("Searching document text in SuperDoc...")
            result = self._request(
                "POST",
                f"/api/documents/{active_document_id}/search-text",
                json={
                    "query": query,
                    "max_results": max_results,
                    "context_chars": context_chars,
                },
            )
            await emitter.status("Document text search completed", done=True)
            return {
                "success": True,
                "document_id": active_document_id,
                "query": query,
                "total_chars": int(result.get("total_chars", 0)),
                "matches": result.get("matches", []),
                "count": len(result.get("matches", [])),
            }
        except Exception as exc:
            await emitter.status(f"Failed to search document text: {exc}", done=True)
            return {"success": False, "error": str(exc)}

    async def apply_document_actions(
        self,
        document_id: str = "",
        actions: list[dict] | str | None = None,
        file_id: str = "",
        filename: str = "",
        strict: bool = True,
        __files__=None,
        __chat_id__: Optional[str] = None,
        __message_id__: Optional[str] = None,
        __event_emitter__: Callable[[dict], Awaitable[None]] = None,
    ) -> dict:
        """
        Apply structured action patches to an existing SuperDoc document.
        Preferred editing path for large/complex documents:
        `search_document_text` -> `get_document_text` (windowed) -> `apply_document_actions`.
        If `document_id` is empty, tool tries to use active document bound to current chat/file context.

        Supported actions:
        - {"type":"replace","find":"...","replace":"..."}
        - {"type":"replaceAll","find":"...","replace":"..."}
        - {"type":"insertContent","content":"<p>...</p>","position":"start|end"}

        :param document_id: Existing SuperDoc document UUID
        :param actions: List of action objects or JSON-encoded list
        :param file_id: Optional OpenWebUI file UUID for active-document lookup
        :param filename: Optional filename override
        :param strict: If true, returns failure when zero actions are applied
        :return: JSON with document_id, changes, viewer_url, and assistant reply
                 (summary + link, plus optional Artifact HTML iframe block when enabled)
        """
        emitter = EventEmitter(__event_emitter__)
        try:
            active_document_id = self._resolve_document_id(
                document_id=document_id,
                file_id=file_id,
                __files__=__files__,
                __chat_id__=__chat_id__,
                __message_id__=__message_id__,
            )
            if not active_document_id:
                raise ValueError(
                    "No active SuperDoc document found. Attach a .docx once or pass document_id explicitly."
                )
            candidate_file_ids = self._operation_file_ids(file_id, __files__)
            parsed_actions = actions
            if parsed_actions is None:
                raise ValueError("actions is required")
            if isinstance(parsed_actions, str):
                parsed_actions = json.loads(parsed_actions)
            if not isinstance(parsed_actions, list):
                raise ValueError("actions must be a list or JSON-encoded list")
            strict_value = (
                strict
                if isinstance(strict, bool)
                else str(strict or "").strip().lower() not in {"", "0", "false", "no", "off"}
            )

            await emitter.status("Applying action patches in SuperDoc...")
            result = self._request(
                "POST",
                f"/api/documents/{active_document_id}/apply-actions",
                json={
                    "actions": parsed_actions,
                    **({"filename": filename} if filename else {}),
                    "metadata": self._context_metadata(__chat_id__, __message_id__, candidate_file_ids),
                    "strict": strict_value,
                },
            )

            document = result.get("document", {})
            final_filename = document.get("filename", filename or "document.docx")
            viewer_url = self._viewer_url(active_document_id)
            changes = result.get("changes", {}) or {}
            assistant_reply = self._build_assistant_reply(
                "Document patched in SuperDoc",
                final_filename,
                viewer_url,
            )
            self._remember_document_binding(active_document_id, __chat_id__, candidate_file_ids)

            await emitter.citation(final_filename, viewer_url)
            await self._refresh_open_artifact(emitter, viewer_url)
            await emitter.status("Action patches applied in SuperDoc", done=True)

            return {
                "success": True,
                "document_id": active_document_id,
                "filename": final_filename,
                "viewer_url": viewer_url,
                "changes": {
                    "applied": int(changes.get("applied", 0)),
                    "units": int(changes.get("units", 0)),
                    "warnings": changes.get("warnings", []),
                },
                "assistant_reply": assistant_reply,
                "message": assistant_reply,
            }
        except Exception as exc:
            await emitter.status(f"Failed to apply action patches: {exc}", done=True)
            return {"success": False, "error": str(exc)}

    async def create_document(
        self,
        document_html: str,
        filename: str = "ai_generated_document.docx",
        file_id: str = "",
        __files__=None,
        __chat_id__: Optional[str] = None,
        __message_id__: Optional[str] = None,
        __event_emitter__: Callable[[dict], Awaitable[None]] = None,
    ) -> dict:
        """
        Create a new DOCX in SuperDoc from the final document HTML.
        Call this only after you have already drafted the complete document content.
        Do not pass the user's request here; pass the final HTML or text that should become the document.
        Chat output must stay concise: short status + viewer URL.
        When Artifact embedding is enabled, assistant_reply also includes an HTML iframe code block.

        :param document_html: Final document content as valid HTML (preferred) or plain text
        :param filename: Output DOCX filename
        :return: JSON with document_id, viewer_url, and `assistant_reply`
                 (summary + link, plus optional Artifact HTML iframe block)
        """
        emitter = EventEmitter(__event_emitter__)
        try:
            await emitter.status("Creating document in SuperDoc...")
            candidate_file_ids = self._operation_file_ids(file_id, __files__)
            result = self._request(
                "POST",
                "/api/documents/create-from-html",
                json={
                    "html": document_html,
                    "filename": filename,
                    "metadata": self._context_metadata(__chat_id__, __message_id__, candidate_file_ids),
                },
            )
            document = result.get("document", {})
            document_id = document.get("id")
            viewer_url = self._viewer_url(document_id)
            final_filename = document.get("filename", filename)
            self._remember_document_binding(document_id, __chat_id__, candidate_file_ids)
            assistant_reply = self._build_assistant_reply(
                "Document created in SuperDoc",
                final_filename,
                viewer_url,
            )

            await emitter.citation(final_filename, viewer_url)
            await self._refresh_open_artifact(emitter, viewer_url)
            await emitter.status("Document created in SuperDoc", done=True)

            return {
                "success": True,
                "document_id": document_id,
                "filename": final_filename,
                "viewer_url": viewer_url,
                "assistant_reply": assistant_reply,
                "message": assistant_reply,
            }
        except Exception as exc:
            await emitter.status(f"Failed to create document: {exc}", done=True)
            return {"success": False, "error": str(exc)}

    async def edit_document(
        self,
        document_html: str,
        document_id: str = "",
        file_id: str = "",
        filename: str = "",
        __files__=None,
        __chat_id__: Optional[str] = None,
        __message_id__: Optional[str] = None,
        __event_emitter__: Callable[[dict], Awaitable[None]] = None,
    ) -> dict:
        """
        Fallback full-document rewrite for explicit "rewrite/replace entire document" requests.
        If `document_id` is empty, the tool first tries active document bound to current chat.
        If no active document is found, it imports attached DOCX from the current chat.
        For normal targeted edits, use:
        `search_document_text` -> `get_document_text` (windowed) -> `apply_document_actions`.
        Chat output must stay concise: short status + viewer URL.
        When Artifact embedding is enabled, assistant_reply also includes an HTML iframe code block.

        :param document_html: Final edited document content as valid HTML (preferred) or plain text
        :param document_id: Existing SuperDoc document UUID. Leave empty to use the current attached DOCX.
        :param file_id: Optional OpenWebUI file UUID if you need a specific attachment
        :param filename: Optional filename override for the updated DOCX
        :return: JSON with document_id, viewer_url, and `assistant_reply`
                 (summary + link, plus optional Artifact HTML iframe block)
        """
        emitter = EventEmitter(__event_emitter__)
        try:
            await emitter.status("Updating document in SuperDoc...")

            candidate_file_ids = self._operation_file_ids(file_id, __files__)
            active_document_id = self._resolve_document_id(
                document_id=document_id,
                file_id=file_id,
                __files__=__files__,
                __chat_id__=__chat_id__,
                __message_id__=__message_id__,
            )
            active_filename = filename

            if not active_document_id:
                file_model = self._resolve_file_model(file_id, __files__, __chat_id__, __message_id__)
                if getattr(file_model, "id", None):
                    candidate_file_ids.append(str(file_model.id))
                upload_result = self._upload_to_superdoc(
                    file_model,
                    metadata=self._context_metadata(__chat_id__, __message_id__, candidate_file_ids),
                )
                active_document_id = upload_result.get("document", {}).get("id")
                if not active_filename:
                    active_filename = self._preferred_filename(file_model)
                self._remember_document_binding(active_document_id, __chat_id__, candidate_file_ids)

            result = self._request(
                "POST",
                f"/api/documents/{active_document_id}/replace-html",
                json={
                    "html": document_html,
                    **({"filename": active_filename} if active_filename else {}),
                    "metadata": self._context_metadata(__chat_id__, __message_id__, candidate_file_ids),
                },
            )
            document = result.get("document", {})
            final_filename = document.get("filename", active_filename or "document.docx")
            viewer_url = self._viewer_url(active_document_id)
            self._remember_document_binding(active_document_id, __chat_id__, candidate_file_ids)
            assistant_reply = self._build_assistant_reply(
                "Document updated in SuperDoc",
                final_filename,
                viewer_url,
            )

            await emitter.citation(final_filename, viewer_url)
            await self._refresh_open_artifact(emitter, viewer_url)
            await emitter.status("Document updated in SuperDoc", done=True)

            return {
                "success": True,
                "document_id": active_document_id,
                "filename": final_filename,
                "viewer_url": viewer_url,
                "assistant_reply": assistant_reply,
                "message": assistant_reply,
            }
        except Exception as exc:
            await emitter.status(f"Failed to update document: {exc}", done=True)
            return {"success": False, "error": str(exc)}
