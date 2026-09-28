"""``Device``: the base class every hardware adapter subclasses."""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any, ClassVar, TypeVar

from .config import ServerConfig
from .errors import NOT_SUPPORTED, DeviceError
from .panel import PanelItem
from .pinout import Pinout
from .streams import StreamRegistry

T = TypeVar("T")


class Device:
    """One physical device behind one MCP server.

    Subclasses set the class attributes, implement the blocking lifecycle
    methods and mark public operations with :func:`hardwareharness_device_sdk.tool`.
    Lifecycle methods and tools run in worker threads, serialized by the
    server's operation lock; background threads (serial readers) that touch
    the driver must take ``self.io_lock`` as well.

    ``open`` must leave the device usable; the SDK calls ``safe_state``
    right after ``open`` and before ``close``, and retries a failed ``open``.
    """

    manufacturer: ClassVar[str] = ""
    model: ClassVar[str] = ""
    prefix: ClassVar[str] = ""
    capabilities: ClassVar[tuple[str, ...]] = ()
    version: ClassVar[str] = "0.0.0"
    instructions: ClassVar[str] = "One MCP Server controls exactly one hardware device."

    def __init__(self, config: ServerConfig) -> None:
        self.config = config
        self.streams = StreamRegistry()
        self.io_lock = threading.RLock()

    @property
    def hardware_id(self) -> str:
        return self.config.hardware_id

    @property
    def dry_run(self) -> bool:
        return self.config.dry_run

    def select_driver(self, real: Callable[[], T], simulated: Callable[[], T]) -> T:
        """Build the vendor driver, or its simulator when ``HARDWARE_DRY_RUN`` is set."""
        return simulated() if self.dry_run else real()

    def tool_name(self, name: str) -> str:
        return f"{self.prefix}_{name}"

    # --- lifecycle (blocking) ----------------------------------------
    def open(self) -> Any:
        return None

    def close(self) -> Any:
        return None

    def safe_state(self) -> Any:
        """Drive every output to its configured safe value; default: nothing to do."""
        return {"safe": True, "action": "none"}

    # --- declarations -------------------------------------------------
    def pinout(self) -> Pinout:
        raise DeviceError(f"{self.model} publishes no pinout", category=NOT_SUPPORTED)

    def capability_details(self) -> dict[str, Any]:
        """Nonsecret limits and effective settings; must not touch the driver."""
        return {}

    def panel(self) -> list[PanelItem]:
        return []
