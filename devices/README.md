# Hardware device plugins

霸天虎 V2 常用接口模型见 [`manuals/stm32-batianhu-v2/README.md`](manuals/stm32-batianhu-v2/README.md)。
新硬件适配器按技能 [`skill/device-plugin`](../skill/device-plugin/SKILL.md) 编写。

Each hardware device is the device plugin SDK plus one adapter, loaded by the
testStand backend as a plugin. The four boards (PCI-1710L, PCI-1762,
PCI-6208V, CP-118U-I) are built from this directory. A release of testStand ships
none of them: each adapter is delivered as a `.tsdev` device package and installed
on the bench page (+ → 添加设备…), which installs its driver and adds the device in one step.

```
sdk/                     teststand_device_sdk: DeviceHost, plugin loading (in process or child
                         process), builtin tools, envelope, lifecycle, safe_state, streams (ring
                         buffer), /device manifest, waveform player, compliance suite
adapters/<adapter>/      teststand_adapter_<adapter>: adapter.py, driver.py, sim.py, pinout.py, tests/
native/                  DAQNavi bridges (hwcli_*.cpp) and build.py, built into adapters/<card>/.../bin/
pack.py                  builds dist/<type>-<version>.tsdev device packages
test.ps1                 local tests: SDK, every adapter, dry-run compliance
```

## Device packages

```powershell
python native/build.py      # DAQNavi bridges (MinGW-w64 g++), needed by pci1710l and pci1762
python pack.py --all        # tests + --check, wheel, manifest -> dist/*.tsdev
```

A package is a ZIP of `package.json` (type, version, manufacturer, model, isolation,
SDK range, vendor drivers, SHA-256 of every wheel) and `wheels/*.whl`. List the
vendor drivers the bench needs and the files that must be in the wheel under
`[tool.teststand.package]` in the adapter's `pyproject.toml`.

## Device plugins

An adapter package registers its `Device` subclass under the entry point group
`teststand.devices`; the entry point name is the device type:

```toml
[project.entry-points."teststand.devices"]
pci1762 = "teststand_adapter_pci1762:DEVICE"
```

The backend calls `open_device(type, config)`. `config` is a `DeviceConfig`, usually
built with `DeviceConfig.from_mapping({deviceId, hardwareId, manufacturer, model,
dryRun, settings})`; `settings` holds the adapter's nonsecret options. In the backend
a device instance is the record `{deviceId, label, hardwareId,
type, settings, enabled}` and always drives the real hardware; `dryRun` (the simulated
driver) is for the adapter's own tests and `--check` only.
`device_types()` lists the installed types, `load_device()` also accepts
`module` or `module:ClassName`.

`Device.isolation` decides where the device runs; both give the same async handle
(`start`, `stop`, `describe`, `call`, `read_stream`, `seek`, `watch`, `unwatch`,
`read_blob`, `safe_all`):

| `isolation` | Handle | Runs |
|---|---|---|
| `inproc` (default) | `InprocDevice` | a `DeviceHost` in the backend process |
| `subprocess` | `SubprocessDevice` | a `DeviceHost` in `python -m teststand_device_sdk.child`, JSON lines over stdio; stdout noise of the driver goes to stderr, stdin EOF drives the device safe and exits, and on Windows the child dies with the backend |

`DeviceHost` holds one device, its lifecycle (open, `safe_state` after open and
before close, retry of a failed open), its tools and its streams. Tools are
described as plain dicts (`name`, `description`, `inputSchema`, `outputSchema`,
`annotations`, `_meta.teststand`); `call(name, arguments, operation_id=)`
validates the arguments and returns the JSON envelope `{ok, data|error, meta}`.
`manifest()` is the generated `/device` declaration. `now_ms()` (`clock.py`) is the
shared clock of every record, watermark and tool timing.

## Simulation and dry-run

`"dryRun": true` in the config or `HARDWARE_DRY_RUN=1` makes `select_driver` pick
the adapter's simulator; nothing touches hardware and `/device.identity.dryRun` is
true. Simulation switches, all off by default so simulated inputs read idle values:

| Variable | Effect |
|---|---|
| `HARDWARE_DRY_RUN_AI_NOISE=1` | simulated analog inputs move |
| `HARDWARE_DRY_RUN_SERIAL_LOOPBACK=1` | serial TX is echoed back to RX |

## Test locally

```powershell
.\test.ps1                  # SDK tests, then every adapter's tests and dry-run compliance check
.\test.ps1 -Target sdk
.\test.ps1 -Target pci6208v
uv run python -m teststand_device_sdk --adapter pci1710l --check   # compliance only
```

`--check` runs the compliance suite in process against the dry-run simulator: tool
contract and semantics, range rejection, `operationId` echo, streams (record format,
increasing `seq`/`t`, advancing watermark, idle-driven event streams), the `/device`
shape, revision and identity, and an idempotent `safe_state`. Adapter tests use
`teststand_device_sdk.testing.serve(Device)`, which starts the host on a
background event loop: `hh.call("tool", **args)` returns the envelope, `hh.device()`
the declaration and `hh.subscribe(streamId)` reads a stream as `hello`, `batch`,
`gap` and `status` events.

## Device contract

Contract revision `2026-10-07.1`. Builtin tools: `get_device_info`, `list_hardware`,
`get_hardware_info`, `<prefix>_stream_read`, plus `<prefix>_transact` when a byte
stream has a writer and `<prefix>_blob_read` when a blob stream exists, and
`teststand_prepare_shutdown`. The declaration `{manifestRevision,
contractRevision, identity, description, pinout, streams, capabilities, tools[{name,
kind}]}` carries the pinout and the stream declarations; `manifestRevision` (sha256
over the canonical declaration) says when to read it again.

Every call may carry an `operationId` (tags the stream records it causes); the
result `meta` returns `operationId`, `timing` and `streamRefs`. Each device tool
declares `operationSemantics` explicitly. Devices report measurements and state; pass/fail
judging belongs to the test step, not the device. See
`skill/device-plugin/references/contract.md` for the full contract and `streams.md` for
stream types and stream metadata.

Streams are read with `read_stream(streamId, cursor, limit, epoch)`: records
`{seq, t, op?, ...payload}`, `next`, a `watermark` (every record with `t` at or before
it has been returned) and a `gap` when records were evicted or the cursor came from
another epoch. `seek(streamId, since)` finds the first record at or after `since` (on
level streams the one still in force); sampled streams only sample while watched
(`watch`/`unwatch`).

Each stream declares its metadata in `/device.streams`: `unit`, `label`, `kind`
(`measured` or `setpoint`), `width`/`bitLabels` for bits, `rateHz` for sampled
streams, `writable` for byte streams, and `control` for the `actuate` tools that
write it (`[{action, tool, args}]`, placeholders `{"$": "value" | "bit" | "text" |
"hex" | "id"}`). A stream is a signal: the signal view binds controls to it. Streams
and tools are never related to pins. Byte and frame streams are idle-driven: the
reader thread calls `idle()` after every read return, so the watermark trails the
clock by at most one poll interval (`--check` verifies it).

| Adapter | Streams |
|---|---|
| `pci1710l` | `ai0..15` scalar scan group in V, `measured` (one scan, shared `t`; need `configure_ai`), `di` 16-bit `measured` published on change, `do` 16-bit read back after every write (control `setBit` → `set_level`) |
| `pci1762` | `di` 16-bit (`IDI0..15`) `measured` published on change, `relay` 16-bit (`R0..15`) coil command read back after every write (control `setBit` → `set_relay`, `setMask` → `set_bank`) |
| `pci6208v` (`isolation = "subprocess"`: PCIS-DASK writes to stdout when it loads) | `ao0..7` scalar in V, `setpoint`: the accepted value published on write and every point of a software waveform (`set_waveform`/`stop_waveform`, at most 200 updates/s; `safe_state` stops it) (control `set` → `set_voltage`) |
| `cp118u_i` | `serial1..8` bytes: RX from a 10 ms reader thread that calls `idle()` after every read, TX via the stream writer, `mark` on configure/clear/flush (control `sendText` → `write_text`, `sendHex` → `write_hex`) |

The native vendor CLIs of `pci1710l` and `pci1762` are found through
`settings.hwcliPath` or the `<ADAPTER>_HWCLI_PATH` / `HWCLI_PATH` environment variables.
