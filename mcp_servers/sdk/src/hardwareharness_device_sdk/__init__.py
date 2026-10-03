"""SDK for HardwareHarness device plugins.

An adapter subclasses :class:`Device`, marks blocking methods with :func:`tool`
and registers typed read-only streams in ``self.streams``; its package registers
the class under the ``hardwareharness.devices`` entry point group. The backend
loads it with :func:`open_device`: a :class:`DeviceHost` runs the tools, the
operations, the generated ``/device`` declaration, the streams and the
lifecycle, in the backend process or in an isolated child process.
:mod:`.waveform` provides low-rate software waveforms for static outputs.
"""

from ._version import __version__
from .clock import now_ms
from .config import DeviceConfig, env_flag
from .device import Device
from .device_types import ENTRY_POINT_GROUP, device_types, load_device
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
from .manifest import Manifest, build_manifest
from .operation import Operation
from .host import DeviceHost, HostTool
from .plugin import DeviceHandle, InprocDevice, SubprocessDevice, open_device
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
    "CONTRACT_REVISION", "DEVICE_ERROR", "DEVICE_UNREACHABLE", "ID_SCHEMES",
    "INTERNAL", "INVALID_ARGUMENT", "INVALID_RESPONSE",
    "NOT_CONFIGURED", "NOT_SUPPORTED", "SERVICE_UNAVAILABLE", "SHAPES", "STREAM_KINDS", "STREAM_TYPES",
    "AdapterError", "BitsStream", "BlobStream", "BlockStream", "ByteStream", "Connector",
    "ContractModel", "Device", "DeviceError", "DeviceHandle", "DeviceHost", "ENTRY_POINT_GROUP",
    "HostTool", "InprocDevice", "SubprocessDevice", "FrameStream", "HardwareId",
    "JsonLineBackend", "JsonLineCli", "Manifest", "ModeDefinition", "Operation", "Pin", "PinFunction",
    "Pinout", "ReadResult", "RingBuffer", "Sampler", "ScalarStream",
    "DeviceConfig", "SoftwareWaveform", "Stream", "StreamRegistry", "ToolSpec", "WaveformParams", "__version__",
    "build_manifest", "device_types", "env_flag", "envelope", "error",
    "find_executable", "function", "iso_now", "load_device", "model", "nc", "now_ms", "ok", "open_device", "param",
    "sample_value", "single_connector_pinout", "tool", "unwrap", "waveform_capability",
]
