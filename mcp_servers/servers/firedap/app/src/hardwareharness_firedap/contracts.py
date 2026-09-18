"""Versioned FireDAP public contracts, shipped with the installed service."""

from __future__ import annotations

import inspect
from typing import Annotated, Any, Literal, get_type_hints

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    create_model,
    model_serializer,
    model_validator,
)

CONTRACT_REVISION = "2026-09-17.1"


class ContractModel(BaseModel):
    # Keep vendor extensions, explicit nulls and existing omitted-field behavior.
    model_config = ConfigDict(extra="allow")

    @model_serializer(mode="wrap")
    def preserve_shape(self, handler):
        values = handler(self)
        return {
            key: value
            for key, value in values.items()
            if key in self.model_fields_set or key in (self.model_extra or {})
        }


def model(model_name: str, **fields):
    """(type, description[, default]) declarations generate schemas and validation."""
    return create_model(
        model_name,
        __base__=ContractModel,
        **{
            key: (
                spec[0] | None if len(spec) > 2 and spec[2] is None else spec[0],
                Field(default=spec[2] if len(spec) > 2 else ..., description=spec[1]),
            )
            for key, spec in fields.items()
        },
    )


Error = model(
    "ToolError",
    category=(str, "Stable error category."),
    message=(str, "Failure and recovery detail."),
    retryable=(
        bool,
        "Transport retry advice only; never authorizes replaying a physical action.",
        False,
    ),
    details=(
        Any,
        "Original driver detail, including partial results when available.",
        None,
    ),
    recovery=(str, "Next evidence to obtain before retrying.", None),
)
Meta = model("ToolMeta", timestamp=(str, "UTC response observation time in ISO 8601."))


def envelope(name: str, data_type):
    class Response(ContractModel):
        ok: bool = Field(description="Business success; inspect error when false.")
        message: str = Field(default="", description="Optional human-readable context.")
        data: data_type | None = Field(
            default=None, description="Tool-specific successful result."
        )
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


Hardware = model(
    "HardwareInfo",
    hardwareId=(str, "Bound FireDAP identifier."),
    computerId=(str, "Service host identity."),
    serverId=(str, "Service identity."),
    state=(str, "Lifecycle/last-job state, not MCU behavior."),
    health=(str, "USB enumeration and job health; target is checked per operation."),
    lastError=(dict[str, Any] | None, "Last job error.", None),
    capabilityDetails=(
        dict[str, Any],
        "Nonsecret configured limits and evidence semantics.",
        {},
    ),
)
ServerInfo = model(
    "ServerInfo",
    name=(str, "Service name."),
    version=(str, "Installed package version."),
    serverId=(str, "Service identity."),
    computerId=(str, "Host identity."),
    startupComplete=(bool, "Configuration initialized, not SWD validation."),
    draining=(bool, "New job submissions refused while true."),
    hardware=(list[Hardware], "Exactly one configured FireDAP."),
    contractRevision=(str, "Versioned public contract."),
    capabilities=(dict[str, Any], "Nonsecret effective firmware and execution policy."),
)
Pinout = model(
    "Pinout",
    hardwareId=(str, "Hardware identity."),
    manufacturer=(str, "Reference manufacturer."),
    model=(str, "Reference model."),
    connectors=(list[dict[str, Any]], "Connector identifiers and pin membership."),
    pins=(
        list[dict[str, Any]],
        "Pin positions and reference functions; not detected wiring.",
    ),
    sources=(list[str], "Cited reference sources."),
    pagination=(dict[str, int | None], "Filtered pin paging information.", None),
)
Probe = model(
    "Probe",
    serialNumber=(str, "USB probe serial, not MCU UID."),
    vendor=(str, "USB vendor name."),
    product=(str, "USB product name."),
)
Probes = model(
    "Probes",
    probes=(
        list[Probe],
        "USB enumeration results; absent when returning busy cached state.",
        None,
    ),
    probePresent=(bool, "Cached configured-probe presence while busy.", None),
    busy=(bool, "Hardware job active; enumeration was not repeated.", None),
    observedAt=(str, "UTC enumeration/cache response time.", None),
    evidence=(str, "Fresh USB enumeration versus cached state.", None),
)
Segment = model(
    "FirmwareSegment",
    address=(int, "Load address in target bytes."),
    addressHex=(str, "Same address in hex."),
    length=(int, "Number of bytes."),
)
Firmware = model(
    "FirmwareInspection",
    path=(str, "Resolved path in the SERVICE host namespace."),
    format=(str, "bin/hex/ihex/elf/axf."),
    sha256=(str, "SHA-256 of exact file snapshot."),
    fileBytes=(int, "File length in bytes."),
    programBytes=(int, "Loadable internal Flash byte count."),
    segments=(list[Segment], "Validated nonoverlapping internal Flash ranges."),
)
Artifact = model(
    "ImportedFirmware",
    artifactId=(str, "Content-addressed immutable artifact identifier."),
    filename=(str, "Original basename, retained for display."),
    path=(str, "Service-managed path accepted by inspect/flash/verify."),
    sha256=(str, "Verified SHA-256."),
    fileBytes=(int, "Decoded byte count, max 32 MiB."),
    format=(str, "Accepted filename format; inspection still required."),
    immutable=(Literal[True], "Repeated imports never overwrite existing bytes."),
    requiresInspection=(
        Literal[True],
        "Call firedap_inspect_firmware before hardware operation; BIN needs base_address.",
    ),
)
Identity = model(
    "TargetResult",
    probeSerial=(str, "Connected USB probe identity.", None),
    target=(str, "Configured target model; group-level identity check.", None),
    deviceId=(str, "DBGMCU_IDCODE in hex.", None),
    flashKiB=(int, "Observed Flash capacity in KiB.", None),
    uid=(list[str], "Three target UID words in hex.", None),
    identityLimit=(
        str,
        "Identity observation limits, e.g. F405/407 group not board revision.",
        None,
    ),
    coreState=(str, "Observed target execution state.", None),
    verified=(bool, "True only after byte-for-byte Flash comparison.", None),
    verifiedBytes=(int, "Compared Flash byte count.", None),
    programmed=(bool, "Whether this job programmed Flash.", None),
    reset=(bool, "Whether reset was issued; not proof of application behavior.", None),
    address=(int, "SRAM start address.", None),
    length=(int, "SRAM byte count.", None),
    words=(
        list[int],
        "Little-endian unsigned 32-bit SRAM words; multiword sample is not atomic.",
        None,
    ),
)
Job = model(
    "Job",
    jobId=(str, "Original job identifier; query/wait this rather than resubmitting."),
    operation=(
        Literal["flash", "verify", "target_info", "reset", "read_sram"],
        "Submitted action.",
    ),
    state=(
        Literal["running", "succeeded", "failed"],
        "Only succeeded permits consuming a successful result.",
    ),
    startedAt=(str, "UTC submission time."),
    firmware=(Firmware | None, "Inspection snapshot for flash/verify.", None),
    result=(
        Identity,
        "Operation-specific evidence; only meaningful after succeeded.",
        None,
    ),
    error=(Error, "Terminal failure; target effects can be unknown.", None),
    finishedAt=(str, "UTC terminal time.", None),
    revision=(int, "1 while running; 2 after completion.", None),
    auditError=(str, "Terminal audit persistence failure.", None),
)
BoardReference = model(
    "BoardReference",
    modelVersion=(int, "Packaged board schema revision.", None),
    hardwareId=(str, "Passive reference board identity.", None),
    boardRevision=(str, "Reference board and source revision.", None),
    referenceId=(str, "Stable reference identifier.", None),
    sections=(
        list[str],
        "Available top-level sections; choose one by exact key.",
        None,
    ),
    section=(str, "Selected section.", None),
    items=(
        list[Any],
        "Section items; schematics/net facts retain their native fields.",
        None,
    ),
    offset=(int, "Zero-based section offset.", None),
    total=(int, "Selected section item count.", None),
    nextOffset=(int | None, "Continue this same section; null when finished.", None),
    contentHash=(str, "SHA-256 of packaged reference JSON.", None),
)

DESCRIPTIONS = {
    "get_server_info": "Read installed service version, configured firmware policy and job capabilities without accessing the MCU. Ready does not establish target power, SWD continuity or correct application behavior.",
    "list_hardware": "Enumerate USB probes and return the one configured FireDAP identity. During an active job returns cached probe state. USB presence does not verify target power, SWD wiring or MCU execution.",
    "get_hardware_info": "Read configured FireDAP identity, current job/lifecycle health and nonsecret firmware/execution policy without a target operation. Cached enumeration is not a physical target measurement.",
    "get_pinout": "Read the FireDAP connector reference and sources, optionally filtering connector_id and paging pins. VREF is a target-voltage reference input; this call cannot inspect actual wiring or connector orientation.",
    "firedap_list_probes": "Enumerate CMSIS-DAP USB probes without connecting to or resetting an MCU. While a job runs returns cached presence with busy=true. Probe serial is not the MCU UID, and presence does not prove SWD continuity.",
    "firedap_get_board_reference": "Read packaged passive board wiring, jumpers, shared nets and sources; never query the STM32. Use section='index' to discover sections, then section/offset/limit for bounded results. Omitted section preserves the full legacy document. Match boardRevision to the physical board.",
    "firedap_import_firmware": "Import base64 firmware bytes into service-managed immutable storage, checking SHA-256, filename format and 32 MiB bound. This does not access hardware. Use returned path with firedap_inspect_firmware; imported BIN still needs its correct base_address.",
    "firedap_inspect_firmware": "Inspect a BIN/HEX/IHEX/ELF/AXF on the SERVICE host without hardware access. path must be in effective firmwareRoots or from firedap_import_firmware. Validate addresses and SHA-256; BIN needs explicit base_address, other formats carry addresses.",
    "firedap_flash": "Submit sector programming preserving unwritten bytes and byte-for-byte verification. Use the reviewed inspection SHA-256; wait for original jobId and require succeeded plus result.verified=true. Programming resets/halts the MCU; reset_after=true then restarts it. No mass erase, read-protection unlock, option bytes or external Flash.",
    "firedap_verify": "Submit an attach-only Flash byte comparison with inspected SHA-256, without programming or reset. Wait for succeeded and verified=true. Matching bytes prove content only, not application behavior; submitting again creates another job.",
    "firedap_target_info": "Submit attach-only target identity/core-state read without deliberate reset or Flash writes. Wait for its job result. DBGMCU identity verifies a chip group, not package, board revision or correct firmware behavior.",
    "firedap_reset": "Submit MCU reset, interrupting current firmware execution. Query/wait the returned jobId; timeout does not prove that reset did not occur, so do not automatically resubmit.",
    "firedap_read_sram": "Submit an attach-only main-SRAM read without halt, reset or writes. Aligned address/length, max 4096 bytes; wait for job result. Words are little-endian uint32; multiple words are not an atomic snapshot and their meaning requires matching firmware symbols.",
    "firedap_wait_job": "Wait 1..60 seconds for an EXISTING job. Timeout returns running without cancelling the hardware operation; keep waiting for the same jobId. Consume result only after succeeded, and require verified for flash/verify. Unknown jobs may be from a prior session or evicted history.",
    "firedap_get_job": "Query an existing job without another hardware action. Check running/succeeded/failed and only use result after succeeded; flash/verify additionally require verified=true. Unknown job IDs may reflect session restart or retention eviction; never infer that the original action did not occur.",
}
OUTPUTS = {
    "get_server_info": ServerInfo,
    "list_hardware": list[Hardware],
    "get_hardware_info": Hardware,
    "get_pinout": Pinout,
    "firedap_list_probes": Probes,
    "firedap_get_board_reference": BoardReference,
    "firedap_import_firmware": Artifact,
    "firedap_inspect_firmware": Firmware,
    **{
        name: Job
        for name in (
            "firedap_flash",
            "firedap_verify",
            "firedap_target_info",
            "firedap_reset",
            "firedap_read_sram",
            "firedap_wait_job",
            "firedap_get_job",
        )
    },
}
PARAMS = {
    "hardwareId": (
        str,
        {
            "description": "Bound hardwareId from discovery; the HH gateway inserts it automatically.",
            "min_length": 1,
        },
    ),
    "path": (
        str,
        {
            "description": "SERVICE-host firmware path within effective firmwareRoots; prefer returned import path.",
            "min_length": 1,
        },
    ),
    "expected_sha256": (
        str,
        {
            "description": "SHA-256 of the reviewed exact firmware bytes, 64 hexadecimal characters.",
            "pattern": "^[0-9a-fA-F]{64}$",
        },
    ),
    "base_address": (
        int | None,
        {
            "description": "BIN load address in bytes; normally 134217728 (0x08000000). Required for BIN, forbidden for HEX/ELF/AXF.",
            "ge": 134217728,
            "lt": 135266304,
        },
    ),
    "reset_after": (
        bool,
        {
            "description": "After flash/verify success, reset and restart MCU when true; false leaves the flash operation's halted core. Programming itself resets and halts."
        },
    ),
    "address": (
        int,
        {
            "description": "Main-SRAM byte address 0x20000000..0x2001FFFC, 4-byte aligned; address+length must stay <=0x20020000.",
            "ge": 536870912,
            "le": 537001980,
            "multiple_of": 4,
        },
    ),
    "length": (
        int,
        {
            "description": "Byte count 4..4096, multiple of 4; returned words are little-endian uint32.",
            "ge": 4,
            "le": 4096,
            "multiple_of": 4,
        },
    ),
    "job_id": (
        str,
        {
            "description": "Existing jobId returned by the original submission in this service session.",
            "min_length": 1,
        },
    ),
    "timeout_seconds": (
        int,
        {
            "description": "Bounded wait in seconds; timeout does not cancel or resubmit the job.",
            "ge": 1,
            "le": 60,
        },
    ),
    "filename": (
        str,
        {
            "description": "Single basename ending .bin/.hex/.ihex/.elf/.axf; no directory, drive prefix or control characters.",
            "min_length": 1,
            "max_length": 255,
        },
    ),
    "content_base64": (
        str,
        {
            "description": "Strict base64 of 1..33554432 bytes, without data-URL prefix or whitespace.",
            "min_length": 4,
            "max_length": 44739244,
        },
    ),
    "section": (
        str | None,
        {
            "description": "Use index for section names, then an exact top-level section key; omitted returns legacy full document."
        },
    ),
    "connector_id": (
        str | None,
        {"description": "Exact connectorId from get_pinout; omitted selects all."},
    ),
    "offset": (
        int,
        {
            "description": "Zero-based offset within selected section or filtered pins.",
            "ge": 0,
        },
    ),
    "limit": (
        int | None,
        {
            "description": "Maximum returned entries, 1..200. None preserves the full legacy pinout/document.",
            "ge": 1,
            "le": 200,
        },
    ),
}


def contract_tool(mcp, **options):
    def register(fn):
        if options.get("meta", {}).get("hardwareharness", {}).get("kind") == "internal":
            return mcp.tool(**options)(fn)
        hints = get_type_hints(fn)
        for arg in inspect.signature(fn).parameters:
            typ, fields = PARAMS[arg]
            hints[arg] = Annotated[typ, Field(**fields)]
        name = fn.__name__
        hints["return"] = envelope(name, OUTPUTS[name])
        fn.__annotations__ = hints
        meta = {**options.get("meta", {})}
        meta["hardwareharness"] = {
            **meta.get("hardwareharness", {}),
            "contractRevision": CONTRACT_REVISION,
            "resultSemantics": DESCRIPTIONS[name],
            "operationSemantics": operation_semantics(name),
        }
        return mcp.tool(**{**options, "meta": meta, "description": DESCRIPTIONS[name]})(
            fn
        )

    return register


def operation_semantics(name: str) -> dict[str, Any]:
    reads = {
        "get_server_info",
        "list_hardware",
        "get_hardware_info",
        "get_pinout",
        "firedap_list_probes",
        "firedap_get_board_reference",
        "firedap_inspect_firmware",
        "firedap_get_job",
        "firedap_wait_job",
        "firedap_verify",
        "firedap_target_info",
        "firedap_read_sram",
    }
    evidence = {
        "firedap_flash": "firmware_flash_submission",
        "firedap_verify": "firmware_verification",
        "firedap_get_job": "firmware_job_status",
        "firedap_wait_job": "firmware_job_status",
        "firedap_target_info": "controller_identity",
        "firedap_read_sram": "measurement",
    }.get(name, "controller_state" if name in reads else "observation")
    semantics: dict[str, Any] = {
        "kind": "read"
        if name in reads
        else "actuate"
        if name in {"firedap_flash", "firedap_reset"}
        else "configure",
        "retry": "safe" if name in reads else "never_after_dispatch",
        "stateRequirements": [],
        "stateEffects": ["firmware_job_submitted"] if name == "firedap_flash" else [],
        "evidenceType": evidence,
        "outcomeOnInvalidResponse": "unknown",
        "trusted": True,
    }
    if name in {
        "firedap_flash",
        "firedap_verify",
        "firedap_reset",
        "firedap_target_info",
        "firedap_read_sram",
    }:
        semantics["reconcile"] = {
            "toolName": "firedap_get_job",
            "jobIdResultPath": "jobId",
        }
    return semantics


def capability_details(config: dict) -> dict:
    return {
        "contractRevision": CONTRACT_REVISION,
        "executionMode": "hardware",
        "hardwareCount": 1,
        "concurrentHardwareOperations": 1,
        "frequencyHz": config["frequencyHz"],
        "operationTimeoutSeconds": config.get("operationTimeoutSeconds", 120),
        "firmware": {
            "acceptedFormats": ["bin", "hex", "ihex", "elf", "axf"],
            "maxFileBytes": 33554432,
            "pathNamespace": "service_host",
            "firmwareRoots": config["firmwareRoots"],
            "stagingRoot": config["firmwareStagingRoot"],
            "importTool": "firedap_import_firmware",
            "flashStart": 134217728,
            "flashEndExclusive": 135266304,
        },
        "sram": {
            "start": 536870912,
            "endExclusive": 537001984,
            "alignmentBytes": 4,
            "maxReadBytes": 4096,
        },
        "jobRetention": {
            "maxSessionJobs": 100,
            "lookupScope": "current_service_session",
            "timeoutCancels": False,
        },
        "evidence": "USB probe enumeration is not target identity or wiring validation; programming verification is not firmware behavioral verification.",
    }
