from __future__ import annotations

import ctypes
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Any

from testforge_runtime.config import ServerConfig
from testforge_runtime.contract import HardwareState


class DriverError(Exception):
    def __init__(self, message: str, category: str = "internal", retryable: bool = False, details: Any = None) -> None:
        super().__init__(message)
        self.category = category
        self.retryable = retryable
        self.details = details


class CSdkDriver:
    """Reusable scaffolding for a vendor C/C++ SDK exposed through a Windows DLL.

    Two hazards drive the shape of this class, and both are why every hardware gets its
    own process:

    * Vendor DLLs are rarely thread-safe. Every entry point is serialised through one lock.
    * Vendor DLLs block. A hung call is run on a single worker thread with a wall-clock
      deadline so the MCP request fails instead of wedging the whole Server.

    Subclasses implement `_open_handle`, `_close_handle` and `safe_stop`; everything else
    is identical across hardware and should not be edited when rendering the template.
    """

    def __init__(self, config: ServerConfig) -> None:
        self.config = config
        self.hardware_id = config.hardwareId
        self._lock = threading.RLock()
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sdk")
        self._dll: ctypes.CDLL | None = None
        self._handle: Any = None
        self._state: HardwareState = "closed"
        self._health = "Not opened"
        self._last_error: DriverError | None = None
        self.call_timeout = float(config.driver.get("callTimeoutSeconds", 10.0))

    # ---------------------------------------------------------------- lifecycle

    @property
    def state(self) -> HardwareState:
        return self._state

    @property
    def health(self) -> str:
        return self._health

    @property
    def last_error(self) -> DriverError | None:
        return self._last_error

    @property
    def loaded(self) -> bool:
        return self._dll is not None

    @property
    def driver_version(self) -> str | None:
        return self.config.driver.get("version")

    @property
    def serial_number(self) -> str | None:
        return None

    def open(self) -> None:
        with self._lock:
            if self._state == "open":
                return
            self._state = "initializing"
            try:
                self._dll = self._load_library()
                self._handle = self._call(self._open_handle)
                self._state = "open"
                self._health = "OK"
                self._last_error = None
            except DriverError as error:
                self._state = "unreachable" if error.category == "device_unreachable" else "faulted"
                self._health = str(error)
                self._last_error = error
                raise
            except Exception as error:  # noqa: BLE001 - normalised into the contract's error model
                wrapped = DriverError(str(error), "device_unreachable")
                self._state = "unreachable"
                self._health = str(error)
                self._last_error = wrapped
                raise wrapped from error

    def close(self) -> None:
        with self._lock:
            if self._handle is None:
                self._state = "closed"
                return
            self._state = "closing"
            try:
                self._call(self._close_handle)
            finally:
                self._handle = None
                self._dll = None
                self._state = "closed"
                self._health = "Closed"

    def shutdown(self) -> None:
        try:
            self.close()
        finally:
            self._worker.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------------- calls

    def _load_library(self) -> ctypes.CDLL | None:
        if self.config.simulate:
            return None
        name = self.config.driver.get("library")
        if not name:
            raise DriverError("driver.library is not configured", "invalid_argument")
        try:
            loader = ctypes.WinDLL if hasattr(ctypes, "WinDLL") else ctypes.CDLL
            return loader(name)
        except OSError as error:
            raise DriverError(f"Vendor SDK could not be loaded: {name}", "device_unreachable", details=str(error)) from error

    def _call(self, fn, *args: Any, timeout: float | None = None) -> Any:
        """Serialise and time-bound one vendor SDK entry point."""
        deadline = self.call_timeout if timeout is None else timeout
        with self._lock:
            future = self._worker.submit(fn, *args)
            try:
                return future.result(timeout=deadline)
            except FutureTimeout as error:
                # The worker thread is still stuck inside the DLL; mark the hardware rather
                # than pretending the call succeeded.
                self._state = "faulted"
                self._health = f"Vendor SDK call exceeded {deadline}s"
                wrapped = DriverError(self._health, "timeout", retryable=True)
                self._last_error = wrapped
                raise wrapped from error

    def check(self, code: int, action: str) -> None:
        """Translate a vendor return code into the contract's error model."""
        if code == 0:
            return
        raise DriverError(f"{action} failed with vendor code {code}", "error", details={"code": code})

    # -------------------------------------------------------------- subclass API

    def _open_handle(self) -> Any:
        raise NotImplementedError

    def _close_handle(self) -> None:
        raise NotImplementedError

    def safe_stop(self) -> str:
        """Drive every output to its declared safe value. Must be idempotent.

        Called during startup and prepare_shutdown. Raising here marks the hardware `faulted`.
        """
        raise NotImplementedError
