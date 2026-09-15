"""Versioned, executable public contracts. Packaged with each standalone service."""
from __future__ import annotations

import inspect
import os
from typing import Annotated, Any, Literal, get_type_hints

from pydantic import BaseModel, ConfigDict, Field, create_model, model_serializer, model_validator

CONTRACT_REVISION = "2026-09-15.1"


class ContractModel(BaseModel):
    # Keep vendor extensions, explicit nulls and existing omitted-field behavior.
    model_config = ConfigDict(extra="allow")

    @model_serializer(mode="wrap")
    def preserve_shape(self, handler):
        values = handler(self)
        return {key: value for key, value in values.items()
                if key in self.model_fields_set or key in (self.model_extra or {})}


def model(model_name: str, **fields):
    """(type, description[, default]) declarations generate schemas and validation."""
    return create_model(model_name, __base__=ContractModel, **{
        key: (spec[0] | None if len(spec) > 2 and spec[2] is None else spec[0],
              Field(default=spec[2] if len(spec) > 2 else ..., description=spec[1]))
        for key, spec in fields.items()
    })


Error = model("ToolError", category=(str, "Stable error category."), message=(str, "Failure and recovery detail."),
              retryable=(bool, "Transport retry advice only; never authorizes replaying a physical action.", False),
              details=(Any, "Original driver detail, including partial results when available.", None),
              recovery=(str, "Next evidence to obtain before retrying.", None))
Meta = model("ToolMeta", timestamp=(str, "UTC response observation time in ISO 8601."))


def envelope(name: str, data_type):
    class Response(ContractModel):
        ok: bool = Field(description="Business success; inspect error when false.")
        message: str = Field(default="", description="Optional human-readable context.")
        data: data_type | None = Field(default=None, description="Tool-specific successful result.")
        error: Error | None = None
        meta: Meta

        @model_validator(mode="after")
        def required_branch(self):
            if self.ok and "data" not in self.model_fields_set:
                raise ValueError("Successful response requires data")
            if not self.ok and self.error is None:
                raise ValueError("Failed response requires error")
            return self
    Response.__name__ = name + "Response"
    return Response


Hardware = model("HardwareInfo", hardwareId=(str, "Stable device identifier returned by discovery."),
                 state=(str, "Service lifecycle state; open does not prove external wiring."),
                 health=(str, "Last service/driver health, not end-to-end experiment validation."),
                 capabilities=(list[str], "Declared device capabilities.", []),
                 capabilityDetails=(dict[str, Any], "Versioned limits, effective settings and evidence semantics.", {}),
                 lastError=(dict[str, Any] | None, "Last lifecycle/job error.", None))
ServerInfo = model("ServerInfo", name=(str, "Service name."), version=(str, "Installed server package version."),
                   serverId=(str, "Service identity."), computerId=(str, "Configured host identity."),
                   startupComplete=(bool, "Initialization complete; not a measurement."),
                   draining=(bool, "Service is refusing new operations while stopping."),
                   hardware=(list[Hardware], "Exactly one managed active hardware device."),
                   contractRevision=(str, "Public contract revision.", CONTRACT_REVISION),
                   capabilities=(dict[str, Any], "Nonsecret effective configuration and limits.", {}))
Channel = model("ChannelResult", channel=(int, "Channel index using the tool's advertised origin."))
Voltage = model("VoltageResult", channel=(int, "Zero-based channel."), volts=(float, "Voltage in V; evidence semantics are tool-specific."),
                raw=(int, "Raw ADC code when provided by the driver.", None),
                signal=(str, "AI signal configuration when provided.", None), value_range=(int, "AI range enumeration when provided.", None))
Bit = model("BitResult", channel=(int, "Zero-based channel 0..15."), kind=(str, "DI, DO or RELAY evidence source."), value=(bool, "Input level or controller readback; not contact continuity."))
AiConfig = model("AiConfiguration", channel=(int, "AI channel 0..15."), signal_type=(int, "0=single-ended, 1=differential."), value_range=(int, "Configured range enum."), signal=(str, "Driver signal configuration name.", None))
Level = model("LevelResult", channel=(int, "DO channel 0..15."), level=(bool, "Commanded digital output level."))
Relay = model("RelayResult", channel=(int, "Relay channel 0..15."), closed=(bool, "Commanded coil state."), port=(int, "Driver byte port.", None), bit=(int, "Bit in byte port.", None))
Mask = model("MaskResult", mask=(int, "Commanded 16-bit relay mask."))
SafeDo = model("SafeDoResult", safe_do_mask=(int, "Effective configured 16-bit output safe mask; not necessarily zero."))
SafeRelay = model("SafeRelayResult", relays=(str, "all_open means control state checked; no physical contact measurement."))
SafeAo = model("SafeAoResult", safe_volts=(float, "Effective configured safe output in V applied to all 8 channels."))
SerialConfig = model("SerialConfiguration", channel=(int, "P1..P8."), port=(int, "PComm/Windows COM number."), baud=(int, "Bits per second."), mode=(int, "PComm UART frame-format bits, NEVER RS-232/422/485 DIP setting."), flow=(int, "PComm flow-control mask."), flow_rc=(int, "PComm flow-control return code.", None))
SerialWrite = model("SerialWrite", channel=(int, "P1..P8."), bytes=(int, "Bytes accepted by the driver; may be short, does not prove peer receipt."))
SerialRx = model("SerialRx", channel=(int, "P1..P8."), bytes=(int, "Returned byte count, may be limited by max_bytes."), hex=(str, "Exact raw bytes as space-separated hexadecimal; authoritative decoding evidence."), text=(str, "UTF-8 with replacement for invalid bytes; replacement characters are not valid protocol data."))
SerialFlush = model("SerialFlush", channel=(int, "P1..P8."), what=(str, "FIFO selection rx/tx/both."))
SerialStatus = model("SerialStatus", channel=(int, "P1..P8."), port=(int, "PComm/Windows COM number."), baud=(int, "Configured bits per second."), frame=(str, "UART frame string, e.g. 8N1."), mode=(int, "UART frame bits; not physical electrical mode.", None), flow=(int, "PComm flow-control mask."), lstatus=(int, "Raw driver modem/line status flags; no cable continuity proof."))

DESCRIPTIONS = {
    "get_server_info": "Read service version, readiness and nonsecret effective capabilities without signal actuation. One service manages exactly one active device; ready does not prove the physical experiment or wiring.",
    "list_hardware": "Discover the single device managed by this service. Use its hardwareId in subsequent calls; presence and service health do not verify every channel or external cable.",
    "get_hardware_info": "Read device identity, lifecycle health, capability limits and effective settings. Static declarations and software state are not physical measurements.",
    "get_pinout": "Read packaged connector/pin functions and sources, optionally filtering one connector and paging pins. This reference cannot detect cable position or DIP switches; use returned identifiers verbatim and verify connector orientation against the cited manual.",
    "pci1710l_configure_ai": "Configure one zero-based AI channel before voltage reads. signal_type=0 single-ended or 1 differential; range enums are in the parameter. Differential pairing and reference ground must match the manual; unsupported hardware settings are rejected by the driver.",
    "pci1710l_read_voltage": "Measure one configured AI channel in V. Configure its signal type and range first; a numeric reading alone does not identify the connected source, validate ground wiring or prove the DUT behavior.",
    "pci1710l_read_bit": "Read DI or DO-controller feedback on channel 0..15. DI is an electrical input sample; DO is output-control readback and does not prove voltage at the remote load.",
    "pci1710l_set_level": "Drive one DO channel 0..15 to the requested logic level. This changes real electrical outputs; successful driver acceptance is not a measurement of the load.",
    "pci1710l_safe_state": "Apply the configured safe_do_mask to all 16 digital outputs. The mask can be nonzero; get_hardware_info publishes its effective value. Failure may leave a partial state; do not assume outputs are de-energized.",
    "pci1762_set_relay": "Set RELAY0..15; closed=true energizes the coil. Controller feedback does not prove external contact continuity or load behavior. Consult pinout for actual OUT/COM wiring and load ratings.",
    "pci1762_set_bank": "Set all 16 relays from mask bit0=RELAY0. The driver writes separate 8-bit ports, so the whole bank is not atomic and a failed write may leave partial changes.",
    "pci1762_read_bit": "Read channel 0..15 as DI or relay-control feedback. kind=RELAY selects coil control; DO is its compatibility alias. This cannot measure contact resistance or prove load isolation.",
    "pci1762_safe_state": "Release all 16 relay coils and check control feedback. This actuates real relays. Failure may be partial; all_open describes control state, not a physical continuity measurement.",
    "pci6208v_set_voltage": "Drive AO0..7 in V within [-10,10]; nonfinite or out-of-range requests are rejected before the driver call. Result is the accepted setting, not a measured output voltage; respect connected-load limits.",
    "pci6208v_read_last": "Read the software shadow of the last accepted write during this open session. This board has no ADC output readback; never treat this value as measured voltage. Fails when the channel has no recorded write.",
    "pci6208v_safe_state": "Drive all eight analog outputs to effective safe_volts from get_hardware_info. That configured voltage is not necessarily 0 V. Output is software/driver evidence; failure details identify channels that may remain unsafe.",
    "cp118u_configure_port": "Configure UART frame and flow on P1..P8 without sending payload. Returned mode encodes data/parity/stop bits. RS-232/422/485 is a physical DIP-switch setting that software cannot detect or change.",
    "cp118u_write_text": "Transmit text encoded as UTF-8 with no automatic newline. clear_rx optionally discards prior RX evidence. Returned bytes counts driver acceptance, may be short, and does not prove peer receipt; do not replay automatically after timeout.",
    "cp118u_write_hex": "Transmit exact bytes from hexadecimal, with optional spaces. Use this for binary protocols or a non-UTF-8 encoding. clear_rx discards prior RX; returned bytes is driver acceptance, not peer receipt.",
    "cp118u_read_rx": "Return accumulated RX since the last clear/flush without consuming it; max_bytes returns the oldest prefix. hex is exact; text is UTF-8 with replacement. timeout_ms=0 permits an empty success; positive empty waits retain the existing device_error with empty data in error.details. Repeated reads can contain the same bytes.",
    "cp118u_clear_rx": "Discard this channel's accumulated software RX and hardware RX FIFO. This permanently removes receive evidence; the operation does not transmit or change the electrical mode.",
    "cp118u_flush": "Discard RX, pending TX, or both FIFOs. RX also clears software accumulation; TX can discard pending transmissions. Capture needed evidence before flushing.",
    "cp118u_get_line_status": "Read current UART baud/frame/flow and raw modem line flags. mode is a UART frame code, not an RS-232/422/485 setting. Status flags cannot prove cable continuity, correct DIP switches, or peer response.",
}
OUTPUTS = {
    "get_server_info": ServerInfo, "list_hardware": list[Hardware], "get_hardware_info": Hardware,
    "pci1710l_configure_ai": AiConfig, "pci1710l_read_voltage": Voltage, "pci1710l_read_bit": Bit,
    "pci1710l_set_level": Level, "pci1710l_safe_state": SafeDo,
    "pci1762_set_relay": Relay, "pci1762_set_bank": Mask, "pci1762_read_bit": Bit, "pci1762_safe_state": SafeRelay,
    "pci6208v_set_voltage": Voltage, "pci6208v_read_last": Voltage, "pci6208v_safe_state": SafeAo,
    "cp118u_configure_port": SerialConfig, "cp118u_write_text": SerialWrite, "cp118u_write_hex": SerialWrite,
    "cp118u_read_rx": SerialRx, "cp118u_clear_rx": Channel, "cp118u_flush": SerialFlush, "cp118u_get_line_status": SerialStatus,
}
PARAMS = {
    "hardwareId": (str, {"description": "Bound hardwareId from list_hardware; the HH gateway supplies this automatically.", "min_length": 1}),
    "signal_type": (Literal[0, 1], {"description": "0=SingleEnded; 1=Differential. Check physical pairing in get_pinout/manual."}),
    "value_range": (Literal[1, 2, 3, 4, 12, 7, 8, 9, 10], {"description": "V ranges: 1=±10, 2=±5, 3=±2.5, 4=±1.25, 12=±0.625, 7=0..10, 8=0..5, 9=0..2.5, 10=0..1.25. Driver validates model support."}),
    "level": (bool, {"description": "true=logic high, false=logic low; real output actuation."}),
    "closed": (bool, {"description": "true=relay coil energized; false=released. Not a contact measurement."}),
    "mask": (int, {"description": "16-bit mask, bit0=RELAY0; ports are written sequentially.", "ge": 0, "le": 65535}),
    "volts": (float, {"description": "Finite commanded output in V. Outside [-10,10] is rejected, never clamped.", "ge": -10, "le": 10, "allow_inf_nan": False}),
    "baud": (Literal[50,75,110,134,150,300,600,1200,1800,2400,4800,7200,9600,19200,38400,57600,115200,230400,460800,921600], {"description": "UART bits per second; exact supported PComm rates."}),
    "data_bits": (Literal[5,6,7,8], {"description": "UART data bits per frame."}),
    "parity": (str, {"description": "N=none, O=odd, E=even, M=mark, S=space; case-insensitive.", "pattern": "^[NOEMSnoems]$"}),
    "stop_bits": (Literal[1,2], {"description": "UART stop-bit setting, 1 or 2."}),
    "flow": (int, {"description": "PComm flow-control bitmask passed to sio_flowctrl; 0 disables flow. Hardware flow can own RTS; does not change the RS-485 DIP setting.", "ge": 0}),
    "text": (str, {"description": "UTF-8 payload, sent exactly with no added terminator."}),
    "hex_data": (str, {"description": "Even hexadecimal digits, whitespace allowed; exact raw bytes, e.g. 01 03 00 00."}),
    "clear_rx": (bool, {"description": "Discard software accumulation and hardware RX before transmitting; false preserves evidence."}),
    "timeout_ms": (int, {"description": "Receive collection window in ms; 0 is immediate, positive empty window returns existing error semantics.", "ge": 0, "le": 60000}),
    "max_bytes": (int, {"description": "Maximum bytes from the oldest accumulated prefix; cache is not consumed. 0 preserves legacy unlimited output.", "ge": 0, "le": 1048576}),
    "what": (str, {"description": "FIFO selection: rx, tx, both (case-insensitive). TX discards pending transmission.", "pattern": "^(?i:rx|tx|both)$"}),
    "connector_id": (str | None, {"description": "Exact connectorId from this reference; omitted selects all connectors."}),
    "offset": (int, {"description": "Zero-based pin/section-item offset in the filtered result.", "ge": 0}),
    "limit": (int | None, {"description": "Maximum returned pins/items; omitted preserves full legacy response.", "ge": 1, "le": 200}),
}


def contract_tool(mcp, **options):
    def register(fn):
        if options.get("meta", {}).get("hardwareharness", {}).get("kind") == "internal":
            return mcp.tool(**options)(fn)
        name = fn.__name__
        hints = get_type_hints(fn)
        for arg in inspect.signature(fn).parameters:
            if arg == "channel":
                serial = name.startswith("cp118u")
                typ, fields = int, {"description": "Logical P1..P8 (one-based); COM mapping is in get_hardware_info." if serial else "Zero-based hardware channel; use the pinout's channelIndex.", "ge": 1 if serial else 0, "le": 8 if serial else 7 if name.startswith("pci6208v") else 15}
            elif arg == "kind":
                typ, fields = str, {"description": "DI=input sample; DO=controller feedback" + ("; RELAY=coil control (DO alias)." if name.startswith("pci1762") else "."), "pattern": "^(?i:DI|DO|RELAY)$" if name.startswith("pci1762") else "^(?i:DI|DO)$"}
            else:
                typ, fields = PARAMS[arg]
            hints[arg] = Annotated[typ, Field(**fields)]
        if name in OUTPUTS:
            hints["return"] = envelope(name, OUTPUTS[name])
        fn.__annotations__ = hints
        opts = {**options, "description": DESCRIPTIONS[name]}
        meta = {**opts.get("meta", {})}
        meta["hardwareharness"] = {**meta.get("hardwareharness", {}), "contractRevision": CONTRACT_REVISION,
            "resultSemantics": DESCRIPTIONS[name], "timeoutRecovery": "Query current status/evidence before replaying any physical action; an RPC timeout does not prove non-execution."}
        opts["meta"] = meta
        return mcp.tool(**opts)(fn)
    return register


def capability_details(server_id: str) -> dict[str, Any]:
    """Read process configuration and software state only; never load a device DLL."""
    common = {"contractRevision": CONTRACT_REVISION, "hardwareCount": 1,
              "executionMode": "nonphysical_driver_override" if os.environ.get("HARDWARE_DRY_RUN", "").strip() in {"1", "true", "TRUE", "yes"} else "hardware",
              "concurrentHardwareOperations": 1,
              "hardwareRevision": "unknown", "driverVersion": "unknown",
              "pinoutSource": "get_pinout", "evidence": "Declared limits and process configuration; not physical measurements."}
    if server_id == "CP118U_I_MCP":
        from .cp118u_state import STATE
        common.update(channels={"minimum": 1, "maximum": 8}, portMap={str(ch): port for ch, port in STATE.port_map.items()},
                      physicalMode="unknown", modeSelection="hardware_dip", textEncoding="utf-8", rxSemantics="accumulated_since_clear_nonconsuming_oldest_prefix")
    elif server_id == "PCI6208V_MCP":
        from .pci6208v_state import STATE
        from .pci6208v_safety import env_safe_volts
        common.update(channels={"minimum": 0, "maximum": 7}, voltageRange={"minimum": -10, "maximum": 10, "unit": "V"},
                      effectiveSafeVolts=STATE.safe_volts if STATE.open else env_safe_volts(), safeValueSource="open_session" if STATE.open else "startup_configuration",
                      readLastEvidence="software_shadow", outputAdcReadback=False)
    elif server_id == "PCI1710L_MCP":
        from .pci1710l import VALUE_RANGE_HINT, _safe_mask, _active_safe_do_mask, _open
        common.update(channels={"minimum": 0, "maximum": 15}, signalTypes={"0": "SingleEnded", "1": "Differential"},
                      voltageRanges={str(key): value for key, value in VALUE_RANGE_HINT.items()}, effectiveSafeDoMask=_active_safe_do_mask if _open else _safe_mask(),
                      safeValueSource="open_session" if _open else "startup_configuration", voltageEvidence="adc_sample", doEvidence="controller_readback")
    elif server_id == "PCI1762_MCP":
        common.update(channels={"minimum": 0, "maximum": 15}, safeRelayMask=0, bankAtomic=False,
                      relayReadbackEvidence="controller_state", contactContinuityMeasurement=False)
    return common
