"""SDK for single-device HardwareHarness MCP servers.

An adapter subclasses :class:`Device`, marks blocking methods with :func:`tool`
and registers typed read-only streams in ``self.streams``. :func:`create_app`
turns it into a Streamable HTTP MCP server with Bearer auth, heartbeat
leases, the generated ``/device`` declaration, ``/health``, ``/admin/shutdown``
and the ``/streams/{streamId}`` SSE data channel (plus ``/time`` for clock
sync). :mod:`.waveform` provides low-rate software waveforms for static outputs.
"""

from ._version import __version__
from .app import BearerAuth, DeviceService, create_app
from .clock import now_ms
from .config import ServerConfig, env_flag
from .device import Device
from .envelope import CONTRACT_REVISION, ContractModel, envelope, error, iso_now, model, ok
from .errors import (
    BUSY,
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
from .lease import HEARTBEAT_INTERVAL_MS, LEASE_TIMEOUT_MS
from .manifest import Manifest, build_manifest
from .operation import Operation
from .pinout import (
    Connector,
    ModeDefinition,
    Pin,
    PinFunction,
    Pinout,
    function,
    nc,
    single_connector_pinout,
)
from .ringbuffer import ReadResult, RingBuffer
from .streams import (
    ID_SCHEMES,
    STREAM_KINDS,
    STREAM_TYPES,
    BitsStream,
    BlobStream,
    BlockStream,
    ByteStream,
    FrameStream,
    Sampler,
    ScalarStream,
    Stream,
    StreamRegistry,
)
from .tool import HardwareId, ToolSpec, param, tool
from .waveform import SHAPES, SoftwareWaveform, WaveformParams, sample_value, waveform_capability

__all__ = [
    "BUSY", "CONTRACT_REVISION", "DEVICE_ERROR", "DEVICE_UNREACHABLE", "HEARTBEAT_INTERVAL_MS", "ID_SCHEMES",
    "INTERNAL", "INVALID_ARGUMENT", "INVALID_RESPONSE", "LEASE_TIMEOUT_MS",
    "NOT_CONFIGURED", "NOT_SUPPORTED", "SERVICE_UNAVAILABLE", "SHAPES", "STREAM_KINDS", "STREAM_TYPES",
    "AdapterError", "BearerAuth", "BitsStream", "BlobStream", "BlockStream", "ByteStream", "Connector",
    "ContractModel", "Device", "DeviceError", "DeviceService", "FrameStream", "HardwareId",
    "JsonLineBackend", "JsonLineCli", "Manifest", "ModeDefinition", "Operation", "Pin", "PinFunction",
    "Pinout", "ReadResult", "RingBuffer", "Sampler", "ScalarStream",
    "ServerConfig", "SoftwareWaveform", "Stream", "StreamRegistry", "ToolSpec", "WaveformParams", "__version__",
    "build_manifest", "create_app", "env_flag", "envelope", "error",
    "find_executable", "function", "iso_now", "model", "nc", "now_ms", "ok", "param",
    "sample_value", "single_connector_pinout", "tool", "unwrap", "waveform_capability",
]
