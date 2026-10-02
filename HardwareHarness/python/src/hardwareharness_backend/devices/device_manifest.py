"""A managed device's own declaration: the service's ``GET /device`` (design doc §4.3, §9.7).

The service is the source of truth for a managed device's identity, pictures, pinout and
streams; the terminal only caches the last document it saw (and the assets it references)
so the device page still shows something while the service is offline.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

Record = dict[str, Any]

DEVICE_PATH = "/device"
ASSETS_PATH = "/assets/"
MAX_ASSET_BYTES = 8 * 1024 * 1024


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


async def fetch_asset(http: httpx.AsyncClient, url: str, path: str) -> bytes:
    response = await http.get(service_base_url(url) + ASSETS_PATH + path.lstrip("/"))
    response.raise_for_status()
    if len(response.content) > MAX_ASSET_BYTES:
        raise RuntimeError(f"Asset {path} is larger than {MAX_ASSET_BYTES} bytes")
    return response.content


def asset_paths(document: Record) -> list[str]:
    """Every asset the declaration references: the appearance image and the port diagrams."""
    paths: list[str] = []
    images = document.get("images")
    appearance = images.get("appearance") if isinstance(images, dict) else None
    if isinstance(appearance, dict) and isinstance(appearance.get("asset"), str):
        paths.append(appearance["asset"])
    pinout = document.get("pinout")
    connectors = pinout.get("connectors") if isinstance(pinout, dict) else None
    for connector in connectors if isinstance(connectors, list) else []:
        image = connector.get("image") if isinstance(connector, dict) else None
        if isinstance(image, dict) and isinstance(image.get("asset"), str):
            paths.append(image["asset"])
    return list(dict.fromkeys(paths))


def declared_streams(document: Record) -> list[Record]:
    """``/device.streams[]`` entries that name an ``id`` and a ``type``, as declared."""
    streams = document.get("streams")
    return [
        {**item, "id": str(item["id"]), "type": str(item["type"])}
        for item in (streams if isinstance(streams, list) else [])
        if isinstance(item, dict) and "id" in item and "type" in item
    ]
