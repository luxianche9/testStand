"""SDK for single-device HardwareHarness MCP servers.

An adapter subclasses :class:`Device`, marks blocking methods with :func:`tool`,
registers streams in ``self.streams`` and returns widget templates from
``panel()``. :func:`create_app` turns it into a Streamable HTTP MCP server with
Bearer auth, ``/health``, ``/admin/shutdown`` and the ``/streams/{streamId}``
WebSocket data channel.
"""

from ._version import __version__
from .app import BearerAuth, DeviceService, create_app
from .config import ServerConfig, env_flag
from .device import Device
from .envelope import CONTRACT_REVISION, ContractModel, envelope, error, iso_now, model, ok
from .errors import (
    DEVICE_ERROR,
    DEVICE_UNREACHABLE,
    INTERNAL,
    INVALID_ARGUMENT,
    INVALID_RESPONSE,
    NOT_CONFIGURED,
    NOT_SUPPORTED,
    SERVICE_UNAVAILABLE,
    AdapterError,
    DeviceError,
)
from .jsonline import JsonLineBackend, JsonLineCli, find_executable, unwrap
from .panel import VALUE, PanelItem, SelectOption, ToolBinding, ValueRange
from .pinout import Connector, ModeDefinition, Pin, PinFunction, Pinout, function, nc, single_connector_pinout
from .ringbuffer import ReadResult, RingBuffer
from .streams import BYTES_SCHEMA, ByteStream, SampledStream, Stream, StreamRegistry
from .tool import HardwareId, ToolSpec, param, tool

__all__ = [
    "BYTES_SCHEMA", "CONTRACT_REVISION", "DEVICE_ERROR", "DEVICE_UNREACHABLE", "INTERNAL", "INVALID_ARGUMENT",
    "INVALID_RESPONSE", "NOT_CONFIGURED", "NOT_SUPPORTED", "SERVICE_UNAVAILABLE", "VALUE",
    "AdapterError", "BearerAuth", "ByteStream", "Connector", "ContractModel", "Device", "DeviceError", "DeviceService",
    "HardwareId", "JsonLineBackend", "JsonLineCli", "ModeDefinition", "PanelItem", "Pin", "PinFunction", "Pinout", "ReadResult", "RingBuffer",
    "SampledStream", "SelectOption", "ServerConfig", "Stream", "StreamRegistry", "ToolBinding", "ToolSpec",
    "ValueRange", "__version__", "create_app", "env_flag", "envelope", "error", "find_executable", "function", "iso_now",
    "model", "nc", "ok", "param", "single_connector_pinout", "tool", "unwrap",
]
