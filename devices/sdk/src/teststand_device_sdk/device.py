"""``Device``: the base class every hardware adapter subclasses."""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any, ClassVar, Literal, TypeVar

from .config import DeviceConfig
from .errors import NOT_SUPPORTED, DeviceError
from .pinout import Pinout
from .streams import StreamRegistry

T = TypeVar("T")


class Device:
    """One physical device, hosted by one :class:`~.host.DeviceHost`.

    Subclasses set the class attributes, implement the blocking lifecycle
    methods and mark public operations with :func:`teststand_device_sdk.tool`.
    Lifecycle methods and tools run in worker threads under ``self.io_lock``,
    serialized by the host's operation lock. Stream samplers take
    ``io_lock`` between calls; background threads (serial readers) that touch
    the driver must take it as well. Register read-only data streams in
    ``self.streams`` (see :mod:`teststand_device_sdk.streams`).

    ``open`` must leave the device usable; the SDK calls ``safe_state``
    right after ``open`` and before ``close``, and retries a failed ``open``.

    ``/device`` is generated from the class attributes, :meth:`pinout`,
    :meth:`capability_details` and the stream registry.
    """

    manufacturer: ClassVar[str] = ""
    model: ClassVar[str] = ""
    prefix: ClassVar[str] = ""
    capabilities: ClassVar[tuple[str, ...]] = ()
    version: ClassVar[str] = "0.0.0"
    instructions: ClassVar[str] = "One plugin instance controls exactly one hardware device."
    description: ClassVar[str] = ""
    """One-paragraph human description for ``/device.description``."""
    hardware_revision: ClassVar[str | None] = None
    isolation: ClassVar[Literal["inproc", "subprocess"]] = "inproc"
    """``subprocess`` runs the device in a child process (a driver that writes to stdout, crashes
    or must not share the host's process); ``inproc`` runs it in the host process."""

    def __init__(self, config: DeviceConfig) -> None:
        self.config = config
        self.streams = StreamRegistry()
        self.io_lock = threading.RLock()
        self.simulated_driver = False
        """``select_driver`` picked the simulator; reported as ``/device.identity.dryRun``."""

    @property
    def hardware_id(self) -> str:
        return self.config.hardware_id

    @property
    def dry_run(self) -> bool:
        return self.config.dry_run

    def select_driver(self, real: Callable[[], T], simulated: Callable[[], T]) -> T:
        """Build the vendor driver, or its simulator when ``HARDWARE_DRY_RUN`` is set."""
        if self.dry_run:
            self.simulated_driver = True
            return simulated()
        return real()

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
