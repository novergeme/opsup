"""
title: SuperDoc Artifact Launcher
author: OpsUp Team
author_url: https://opsup.ai
version: 1.0.0
funding_url: https://opsup.ai
license: Commercial
required_open_webui_version: 0.4.0
"""

import html
import json
import re
from typing import Awaitable, Callable, Optional
from urllib.parse import unquote

from pydantic import BaseModel, Field

SUPERDOC_VIEWER_URL_PATTERN = re.compile(
    r"https?://[^\s\"')>]+/viewer/index\.html\?[^\s\"')>]+",
    re.IGNORECASE,
)


class Action:
    class Valves(BaseModel):
        priority: int = Field(
            default=-20,
            description="Display priority in message action row (lower appears first)",
        )
        OPEN_FALLBACK_IN_NEW_TAB: bool = Field(
            default=True,
            description="Open SuperDoc link in a new tab if Preview button is not found",
        )
        SHOW_NOTIFICATIONS: bool = Field(
            default=True,
            description="Show success/warning notifications in chat UI",
        )

    def __init__(self):
        self.valves = self.Valves()

    def _normalize_url(self, value: str) -> str:
        cleaned = unquote(html.unescape(str(value or "").strip()))
        # Trim punctuation that may appear around markdown links.
        return cleaned.rstrip(").,;")

    def _extract_viewer_url_from_text(self, value: str) -> str:
        if not value:
            return ""

        normalized = unquote(html.unescape(str(value)))
        matches = SUPERDOC_VIEWER_URL_PATTERN.findall(normalized)
        if not matches:
            return ""

        for candidate in reversed(matches):
            url = self._normalize_url(candidate)
            if "/viewer/index.html?" in url:
                return url
        return ""

    def _extract_latest_viewer_url(self, body: dict) -> str:
        messages = body.get("messages", []) or []
        for message in reversed(messages):
            url = self._extract_viewer_url_from_text(message.get("content", ""))
            if url:
                return url

        return self._extract_viewer_url_from_text(body.get("content", ""))

    async def _emit_notification(
        self,
        event_emitter: Optional[Callable[[dict], Awaitable[None]]],
        kind: str,
        content: str,
    ):
        if event_emitter and self.valves.SHOW_NOTIFICATIONS:
            await event_emitter(
                {
                    "type": "notification",
                    "data": {"type": kind, "content": content},
                }
            )

    def _build_execute_code(self, message_id: str, viewer_url: str) -> str:
        message_container_id = f"message-{message_id}" if message_id else ""
        fallback_target = "true" if self.valves.OPEN_FALLBACK_IN_NEW_TAB else "false"

        return f"""
const messageContainerId = {json.dumps(message_container_id)};
const viewerUrl = {json.dumps(viewer_url)};
const openFallbackInNewTab = {fallback_target};

const roots = [];
if (messageContainerId) {{
  const messageNode = document.getElementById(messageContainerId);
  if (messageNode) roots.push(messageNode);
}}
if (roots.length === 0) roots.push(document);

const isPreviewButton = (button) => {{
  const text = (button.textContent || '').trim().toLowerCase();
  return text === 'preview' || text.includes('preview');
}};

let previewOpened = false;
for (const root of roots) {{
  const candidates = Array.from(root.querySelectorAll('button')).filter(isPreviewButton);
  if (candidates.length > 0) {{
    candidates[0].click();
    previewOpened = true;
    break;
  }}
}}

if (!previewOpened && viewerUrl) {{
  if (openFallbackInNewTab) {{
    window.open(viewerUrl, '_blank', 'noopener,noreferrer');
  }} else {{
    window.location.assign(viewerUrl);
  }}
}}

return {{
  preview_opened: previewOpened,
  fallback_opened: !previewOpened,
  viewer_url: viewerUrl
}};
""".strip()

    async def action(
        self,
        body: dict,
        __event_emitter__: Callable[[dict], Awaitable[None]] = None,
    ):
        viewer_url = self._extract_latest_viewer_url(body)
        if not viewer_url:
            await self._emit_notification(
                __event_emitter__,
                "warning",
                "SuperDoc viewer link was not found in the current message context.",
            )
            return {
                "success": False,
                "error": "superdoc_viewer_link_not_found",
            }

        message_id = str(body.get("id", "") or "")
        execute_code = self._build_execute_code(message_id, viewer_url)

        if __event_emitter__:
            await __event_emitter__(
                {
                    "type": "status",
                    "data": {
                        "description": "Opening SuperDoc in Artifact preview...",
                        "done": False,
                    },
                }
            )
            await __event_emitter__(
                {
                    "type": "execute",
                    "data": {"code": execute_code},
                }
            )
            await __event_emitter__(
                {
                    "type": "status",
                    "data": {
                        "description": "SuperDoc preview opened",
                        "done": True,
                    },
                }
            )

        await self._emit_notification(
            __event_emitter__,
            "success",
            "SuperDoc preview action executed.",
        )

        return {
            "success": True,
            "viewer_url": viewer_url,
            "message_id": message_id,
        }
