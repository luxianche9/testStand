"""A managed device's own declaration: the service's ``GET /device`` (design doc §4.3, §9.7).

The service is the source of truth for a managed device's identity, pinout and streams;
the terminal only caches the last document it saw so the device page still shows something
while the service is offline.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

Record = dict[str, Any]

DEVICE_PATH = "/device"


def service_base_url(url: str) -> str:
    """``http://host:port`` of a service whose MCP endpoint is ``url`` (``.../mcp``)."""
    parts = urlsplit(url)
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path.rstrip("/").removesuffix("/mcp"), "", "")
    )


async def fetch_device(http: httpx.AsyncClient, url: str) -> Record | None:
    """The ``/device`` document, or ``None`` when the service predates it (404)."""
    response = await http.get(service_base_url(url) + DEVICE_PATH)
    if response.status_code == 404:
        return None
    response.raise_for_status()
    document = response.json()
    if not isinstance(document, dict) or not document.get("manifestRevision"):
        raise RuntimeError(f"{url}: /device is not a device declaration")
    return document


def declared_streams(document: Record) -> list[Record]:
    """``/device.streams[]`` entries that name an ``id`` and a ``type``, as declared."""
    streams = document.get("streams")
    return [
        {**item, "id": str(item["id"]), "type": str(item["type"])}
        for item in (streams if isinstance(streams, list) else [])
        if isinstance(item, dict) and "id" in item and "type" in item
    ]
