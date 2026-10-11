"""Devices-JC JCXD-RS-CPCI-8MI: 8 isolated serial channels as COM ports (RSX8_JC virtual-port driver).

Hardware manual V1.0 / software manual V1.0. With the "ports" driver installed each physical channel
is a Windows COM port; its electrical mode (RS-232, RS-422, RS-485) and a self-loop flag are port
properties set in Device Manager (Port Settings -> Vendor Tools), stored as ``RsMode`` (1 RS-232,
2 RS-422, 3 RS-485) and ``LoopBack`` under ``Enum\\PCIUART\\OEMPORT\\*&Port<n>\\Device Parameters``.
The plugin reads them; it never changes them.

A reader thread polls every configured channel and appends RX chunks to ``serial<n>``; every
transmit goes through ``stream.send`` so TX lands on the same stream; configure and clear leave
``mark`` records. ``read_rx`` returns RX since the last clear without consuming it.
"""

from __future__ import annotations

import logging
import sys
import threading
from typing import Any, Literal

from teststand_device_sdk import (
    DEVICE_UNREACHABLE,
    INVALID_ARGUMENT,
    NOT_CONFIGURED,
    ByteStream,
    Check,
    Device,
    DeviceConfig,
    DeviceError,
    Pinout,
    check_equal,
    model,
    param,
    tool,
)
from teststand_device_sdk.serialport import SerialPort, SimulatedSerialPort

from .pinout import pinout as build_pinout

log = logging.getLogger(__name__)

CHANNELS = 8
MODES = {1: "RS232", 2: "RS422", 3: "RS485"}
MAX_BAUD = {"RS232": 115_200, "RS422": 2_000_000, "RS485": 2_000_000}
MIN_BAUD = 687
ENUM_KEY = r"SYSTEM\CurrentControlSet\Enum\PCIUART\OEMPORT"
READ_CHUNK = 4096
POLL_S = 0.01

PortInfo = model("Rsx8Port", channel=(int, "Physical channel 0..7."), port=(str, "Windows COM port."),
                 mode=(str, "Electrical mode from the driver (RS232, RS422, RS485) or unknown."),
                 loopback=(bool, "Driver self-loop flag (TX looped to RX on the card)."),
                 configured=(bool, "Opened and configured in this session."),
                 settings=(dict[str, Any], "baudrate, bytesize, parity, stopbits when configured.", None))
SerialWrite = model("Rsx8Write", channel=(int, "Channel 0..7."),
                    bytes=(int, "Bytes the driver accepted; does not prove the peer received them."))
SerialRx = model("Rsx8Rx", channel=(int, "Channel 0..7."), bytes=(int, "Returned byte count."),
                 hex=(str, "Raw bytes as space-separated hex; authoritative."),
                 text=(str, "UTF-8 with replacement characters for invalid bytes."),
                 overflow=(bool, "Bytes after the last clear were evicted from the stream buffer.", False))
SafeResult = model("Rsx8Safe", flushed=(list[int], "Channels whose pending TX was discarded."))

Channel = param(int, "Physical channel 0..7 (OUTn/INn on the SCSI-68).", ge=0, le=CHANNELS - 1)


def registry_ports() -> dict[int, dict[str, Any]]:
    """Physical channel -> {port, mode, loopback} from the RSX8_JC port driver; {} off Windows or if absent."""
    if sys.platform != "win32":
        return {}
    import winreg

    found: dict[int, dict[str, Any]] = {}
    try:
        root = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, ENUM_KEY)
    except OSError:
        return {}
    with root:
        index = 0
        while True:
            try:
                instance = winreg.EnumKey(root, index)
            except OSError:
                break
            index += 1
            tail = instance.rsplit("&", 1)[-1].lower()
            if not tail.startswith("port") or not tail[4:].isdigit():
                continue
            try:
                with winreg.OpenKey(root, rf"{instance}\Device Parameters") as params:
                    values = {name: winreg.QueryValueEx(params, name)[0] for name in ("PortName", "RsMode", "LoopBack")}
            except OSError:
                continue
            found[int(tail[4:])] = {"port": str(values["PortName"]).upper(),
                                    "mode": MODES.get(int(values["RsMode"]), f"unknown({values['RsMode']})"),
                                    "loopback": bool(values["LoopBack"])}
    return found


class JcxdRsx8(Device):
    manufacturer = "Devices-JC"
    model = "JCXD-RS-CPCI-8MI"
    prefix = "rsx8"
    capabilities = ("serial_rs232_rs422_rs485",)
    isolation = "subprocess"
    version = "1.0.0"
    instructions = ("JCXD-RS-CPCI-8MI: 8 isolated serial channels 0..7, each a Windows COM port. port_info shows the "
                    "COM port and the RS-232/422/485 mode set in Device Manager. configure_port before traffic; "
                    "write_text/write_hex transmit; TX, RX and marks are on streams serial0..serial7; "
                    "rsx8_transact sends and waits for a reply.")
    description = ("Devices-JC JCXD-RS-CPCI-8MI, 3U CPCI card with 8 isolated asynchronous serial channels on one "
                   "SCSI-68 (RS-232 up to 115200 bit/s, RS-422/RS-485 up to 2 Mbit/s), exposed as COM ports by the "
                   "RSX8_JC driver. The electrical mode of each channel is read from the driver; streams "
                   "serial0..serial7 carry TX, RX and configuration marks.")

    def __init__(self, config: DeviceConfig) -> None:
        super().__init__(config)
        settings = config.settings
        found = {} if config.dry_run else registry_ports()
        override = settings.get("portMap")
        if override:
            names = [part.strip().upper() for part in (override.split(",") if isinstance(override, str) else override)]
            if len(names) != CHANNELS:
                raise ValueError("portMap must list 8 COM ports for channels 0..7, e.g. COM3,...,COM10")
            found = {n: {**found.get(n, {"mode": "unknown", "loopback": False}), "port": names[n]}
                     for n in range(CHANNELS)}
        if not found:
            found = {n: {"port": f"COM{3 + n}", "mode": "RS485" if config.dry_run else "unknown", "loopback": False}
                     for n in range(CHANNELS)}
        self.ports = found
        expected = settings.get("expectedModes")
        self.expected_modes: list[str] | None = None
        if expected:
            modes = [part.strip().upper() for part in (expected.split(",") if isinstance(expected, str) else expected)]
            if len(modes) != CHANNELS or any(mode not in MAX_BAUD for mode in modes):
                raise ValueError("expectedModes must list 8 of RS232/RS422/RS485 for channels 0..7")
            self.expected_modes = modes
        self.rx_buffer_bytes = int(settings.get("rxBufferBytes", 1 << 20))
        self.backends: dict[int, Any] = {}
        self.settings_by_channel: dict[int, dict[str, Any]] = {}
        self.rx_cursor: dict[int, int] = {}
        self._stop = threading.Event()
        self._reader: threading.Thread | None = None
        for channel in range(CHANNELS):
            self.streams.add(ByteStream(f"serial{channel}", writer=lambda data, ch=channel: self._send(ch, data),
                                        max_bytes=self.rx_buffer_bytes, label=f"CH{channel} {found[channel]['port']}"))

    def _stream(self, channel: int) -> ByteStream:
        stream = self.streams[f"serial{channel}"]
        assert isinstance(stream, ByteStream)
        return stream

    def _new_port(self, name: str) -> Any:
        return SimulatedSerialPort(name, loopback=True) if self.dry_run else SerialPort(name)

    # --- lifecycle ----------------------------------------------------
    def open(self) -> dict[str, Any]:
        missing = [n for n in range(CHANNELS) if n not in self.ports]
        if missing:
            raise DeviceError(f"RSX8_JC ports for channels {missing} not found in the registry; set portMap",
                              category=DEVICE_UNREACHABLE, details={"found": self.ports})
        self.backends, self.settings_by_channel = {}, {}
        self.rx_cursor = {n: self._stream(n).buffer.head for n in range(CHANNELS)}
        for channel in range(CHANNELS):
            self._stream(channel).set_state("not_configured")
        self._stop.clear()
        self._reader = threading.Thread(target=self._read_loop, name="rsx8-rx", daemon=True)
        self._reader.start()
        return {"ports": self.ports}

    def close(self) -> dict[str, Any]:
        self._stop.set()
        if self._reader is not None:
            self._reader.join(timeout=2)
            self._reader = None
        with self.io_lock:
            for backend in self.backends.values():
                backend.close()
            closed = sorted(self.backends)
            self.backends, self.settings_by_channel = {}, {}
        return {"closed": closed}

    # --- receive path -------------------------------------------------
    def _drain(self, channel: int) -> None:
        backend, stream = self.backends[channel], self._stream(channel)
        while True:
            data = backend.read(READ_CHUNK)
            if not data:
                stream.idle()
                return
            stream.rx(data)

    def _read_loop(self) -> None:
        while not self._stop.wait(POLL_S):
            for channel in range(CHANNELS):
                if channel not in self.backends:
                    self._stream(channel).idle()
                    continue
                try:
                    with self.io_lock:
                        if channel in self.backends:
                            self._drain(channel)
                    self._stream(channel).set_state("live")
                except Exception as exc:  # noqa: BLE001 - keep polling the other channels
                    log.warning("CH%s read failed: %s", channel, exc)
                    self._stream(channel).set_state("error", {"category": "device_error", "message": str(exc)})

    def _received(self, channel: int) -> tuple[bytes, bool]:
        buffer = self._stream(channel).buffer
        cursor, head, chunks, overflow = self.rx_cursor.get(channel, 0), buffer.head, [], False
        while cursor < head:
            result = buffer.read(cursor, READ_CHUNK)
            overflow = overflow or result.dropped is not None
            chunks.extend(bytes.fromhex(record["data"]) for record in result.records if record["dir"] == "rx")
            if not result.records:
                break
            cursor = result.next
        return b"".join(chunks), overflow

    def _send(self, channel: int, data: bytes) -> int:
        backend = self.backends.get(channel)
        if backend is None:
            raise DeviceError(f"CH{channel} is not configured; call configure_port first", category=NOT_CONFIGURED)
        with self.io_lock:
            return int(backend.write(data))

    def _info(self, channel: int) -> dict[str, Any]:
        port = self.ports[channel]
        return {"channel": channel, "port": port["port"], "mode": port["mode"], "loopback": port["loopback"],
                "configured": channel in self.backends, "settings": self.settings_by_channel.get(channel)}

    # --- tools --------------------------------------------------------
    @tool(kind="configure", output=PortInfo, effects=("serial_port_configured",),
          description="Open (if needed) and configure one channel's COM port: baud rate, data bits, parity, stop "
                      "bits. RS-232 allows up to 115200 bit/s, RS-422/485 up to 2000000. Sends nothing; leaves a "
                      "configure mark on the channel's stream. The RS mode is set in Device Manager, not here.")
    def configure_port(self, channel: Channel,
                       baudrate: param(int, "Bit/s.", ge=MIN_BAUD, le=2_000_000) = 9600,
                       bytesize: param(Literal[5, 6, 7, 8], "Data bits.") = 8,
                       parity: param(Literal["N", "O", "E", "M", "S"], "Parity.") = "N",
                       stopbits: param(Literal[1, 1.5, 2], "Stop bits.") = 1) -> dict[str, Any]:
        mode = self.ports[channel]["mode"]
        limit = MAX_BAUD.get(mode, 2_000_000)
        if baudrate > limit:
            raise DeviceError(f"{baudrate} bit/s exceeds {limit} for {mode}", category=INVALID_ARGUMENT)
        settings = {"baudrate": baudrate, "bytesize": bytesize, "parity": parity, "stopbits": stopbits}
        backend = self.backends.get(channel)
        if backend is None:
            backend = self._new_port(self.ports[channel]["port"])
            backend.open(**settings)
            self.backends[channel] = backend
        else:
            backend.configure(**settings)
        self.settings_by_channel[channel] = settings
        self._stream(channel).mark(f"configure {baudrate} {bytesize}{parity}{stopbits} {mode}")
        return self._info(channel)

    @tool(kind="actuate", output=SerialWrite, safety_action="safe_state", effects=("serial_tx",),
          description="Transmit text encoded as UTF-8, no newline added. clear_rx first discards RX received so far "
                      "(also from read_rx). The count is what the driver accepted, not proof of receipt.")
    def write_text(self, channel: Channel, text: param(str, "Text to send.", max_length=65536),
                   clear_rx: param(bool, "Discard prior RX first.") = False) -> dict[str, Any]:
        return self._write(channel, text.encode("utf-8"), clear_rx)

    @tool(kind="actuate", output=SerialWrite, safety_action="safe_state", effects=("serial_tx",),
          description="Transmit exact bytes given as hexadecimal (spaces allowed), for binary protocols. clear_rx "
                      "first discards RX received so far. The count is what the driver accepted.")
    def write_hex(self, channel: Channel, hex: param(str, "Bytes as hex, e.g. '01 03 00 00'.", max_length=131072),
                  clear_rx: param(bool, "Discard prior RX first.") = False) -> dict[str, Any]:
        try:
            data = bytes.fromhex(hex)
        except ValueError as exc:
            raise DeviceError(f"invalid hex: {exc}", category=INVALID_ARGUMENT) from exc
        return self._write(channel, data, clear_rx)

    def _write(self, channel: int, data: bytes, clear_rx: bool) -> dict[str, Any]:
        with self.io_lock:
            if clear_rx:
                self._clear(channel)
            sent = self._stream(channel).send(data)
        return {"channel": channel, "bytes": sent}

    def _clear(self, channel: int) -> None:
        backend = self.backends.get(channel)
        if backend is not None:
            backend.flush(rx=True, tx=False)
        self.rx_cursor[channel] = self._stream(channel).mark("clear_rx")["seq"] + 1

    @tool(kind="read", output=SerialRx, evidence="measurement",
          description="Return bytes received on a channel since the last clear, without consuming them (the stream "
                      "keeps them too). max_bytes returns only the first bytes.")
    def read_rx(self, channel: Channel,
                max_bytes: param(int, "Return at most this many bytes.", ge=1, le=1 << 20) = 4096) -> dict[str, Any]:
        with self.io_lock:
            if channel in self.backends:
                self._drain(channel)
        data, overflow = self._received(channel)
        data = data[:max_bytes]
        return {"channel": channel, "bytes": len(data), "hex": data.hex(" "),
                "text": data.decode("utf-8", errors="replace"), "overflow": overflow}

    @tool(kind="configure", output=PortInfo,
          description="Discard RX received so far on one channel (driver buffer and read_rx accumulation); leaves a "
                      "clear_rx mark on the stream. Sends nothing.")
    def clear_rx(self, channel: Channel) -> dict[str, Any]:
        with self.io_lock:
            self._clear(channel)
        return self._info(channel)

    @tool(kind="read", output=PortInfo, evidence="controller_state",
          description="COM port, electrical mode (RS232/RS422/RS485 as set in Device Manager), driver self-loop flag "
                      "and current UART settings of one channel.")
    def port_info(self, channel: Channel) -> dict[str, Any]:
        return self._info(channel)

    @tool(kind="safe", output=SafeResult,
          description="Discard pending TX on every configured channel so nothing further is transmitted. Sends no "
                      "bytes and leaves ports open and configured.")
    def safe_state(self) -> dict[str, Any]:
        flushed = []
        with self.io_lock:
            for channel, backend in self.backends.items():
                backend.flush(rx=False, tx=True)
                flushed.append(channel)
        return {"flushed": sorted(flushed)}

    # --- self-test ----------------------------------------------------
    def self_test(self) -> list[Check]:
        from teststand_device_sdk.serialport import list_ports

        present = {item["port"].upper() for item in list_ports()}
        expected = [self.ports[n]["port"] for n in range(CHANNELS)]
        missing = [port for port in expected if not self.dry_run and port not in present]
        modes = {n: self.ports[n]["mode"] for n in range(CHANNELS)}
        loops = [n for n in range(CHANNELS) if self.ports[n]["loopback"]]
        busy = []
        for channel in range(CHANNELS):
            if channel in self.backends:
                continue
            probe = self._new_port(self.ports[channel]["port"])
            try:
                probe.open()
            except DeviceError as exc:
                busy.append(f"{self.ports[channel]['port']}: {exc}")
            finally:
                probe.close()
        mode_check = (check_equal("电气模式符合接线", modes, dict(enumerate(self.expected_modes)),
                                  "设置 expectedModes 与驱动 RsMode 对照；不符时在设备管理器 → 端口属性 → Vendor Tools 修改")
                      if self.expected_modes else
                      Check("电气模式已知", all(mode in MAX_BAUD for mode in modes.values()), modes, "RS232/RS422/RS485",
                            "设备管理器 → 端口属性 → Vendor Tools（注册表 RsMode）；本插件只读不改；"
                            "设置 expectedModes 可让自检核对接线要求"))
        return [
            check_equal("8 个 COM 口存在", missing, [], "HARDWARE\\DEVICEMAP\\SERIALCOMM 中有 RSX8_JC 端口 " +
                        ", ".join(expected)),
            mode_check,
            check_equal("自环关闭", loops, [], "注册表 LoopBack；自环打开时发送的数据回到本口，不出板卡"),
            check_equal("未占用端口可打开", busy, [], "打开再立即关闭，不发送；被其他程序占用的端口在此列出"),
        ]

    # --- declarations -------------------------------------------------
    def capability_details(self) -> dict[str, Any]:
        return {"channels": CHANNELS, "ports": {str(n): self.ports[n] for n in range(CHANNELS)},
                "baud": {"min": MIN_BAUD, "max": MAX_BAUD}, "modeSource": "driver registry (RsMode), read-only"}

    def pinout(self) -> Pinout:
        return build_pinout(self.hardware_id)
