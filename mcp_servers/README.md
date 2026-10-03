# Hardware MCP servers

本机 FireDAP 烧录服务见 [`servers/firedap/README.md`](servers/firedap/README.md)（仍是旧布局，尚未迁入 SDK），
霸天虎 V2 常用接口模型见 [`hardware-manuals/stm32-batianhu-v2/README.md`](hardware-manuals/stm32-batianhu-v2/README.md)。
新硬件服务按技能 [`skill/mcp-server`](../skill/mcp-server/SKILL.md) 编写。

Each hardware MCP server is the device SDK plus one adapter. The four boards on
`192.168.3.63` (PCI-1710L, PCI-1762, PCI-6208V, CP-118U-I) are built from this
directory; the remote directories are deployment artifacts, not source.

```
sdk/                     hardwareharness_device_sdk: transport, auth, builtin tools, envelope,
                         lifecycle, safe_state, streams (ring buffer + SSE),
                         /device manifest, waveform player, compliance
adapters/<adapter>/      hh_adapter_<adapter>: adapter.py, driver.py, sim.py, pinout.py, tests/
templates/*.ps1          install / uninstall / start / stop / status / runner, rendered per server
test.ps1                 local tests: SDK, every adapter, dry-run compliance
deploy.ps1               thin wrapper around the terminal's deploy pipeline (command line)
dist/                    generated bundles (not committed)
```

## Test locally

```powershell
.\test.ps1                  # SDK tests, then every adapter's tests and dry-run compliance check
.\test.ps1 -Target sdk
.\test.ps1 -Target pci6208v
```

Run one adapter as a live dry-run server (no hardware access; outputs are simulated):

```powershell
$env:HARDWARE_DRY_RUN = "1"
$env:HARDWAREHARNESS_SERVER_CONFIG = "C:\path\to\server.json"
uv run python -m hardwareharness_device_sdk --adapter hh_adapter_pci1710l
uv run python -m hardwareharness_device_sdk --adapter hh_adapter_pci1710l --check   # compliance only
```

Simulation switches, all off by default so simulated inputs read idle values:

| Variable | Effect |
|---|---|
| `HARDWARE_DRY_RUN_AI_NOISE=1` | simulated analog inputs move |
| `HARDWARE_DRY_RUN_SERIAL_LOOPBACK=1` | serial TX is echoed back to RX |

## Service contract

| Path | Purpose |
|---|---|
| `/mcp` | Streamable HTTP MCP, `Authorization: Bearer <token>` |
| `/health` | Unauthenticated health: `{healthy, serverId, hardwareId, state, sdkVersion, manifestRevision}` |
| `/device` | Device declaration (design 5.2), same token: `{manifestRevision, contractRevision, identity, description, pinout, streams, capabilities, tools[{name, kind}]}` |
| `/admin/shutdown` | Authenticated safe shutdown (`safe_state`, then exit) |
| `/streams/{streamId}?from=<seq or latest>&since=<t>` | Read-only SSE data channel (`Last-Event-ID` resumes), same token |
| `/time` | `{serverTime}` for clock-offset estimation, same token |

Contract revision `2026-10-01.1`. Builtin tools: `get_server_info`, `list_hardware`,
`get_hardware_info`, `<prefix>_stream_read`, plus `<prefix>_transact` when a byte
stream has a writer and `<prefix>_blob_read` when a blob stream exists, and
`hardwareharness_prepare_shutdown`. `get_pinout` and `list_streams` are gone: the
pinout, the stream declarations and the images are read once from `/device`, and
`manifestRevision` (sha256 over the canonical declaration plus the asset bytes, also
in `/health`) says when to read it again.

Every call may carry `_meta.operationId` (tags the stream records it causes); the
result `meta` returns `operationId`, `timing` and `streamRefs`. Each device tool
declares `operationSemantics` explicitly. Servers report measurements and state; pass/fail
judging belongs to the test step, not the server. See
`skill/mcp-server/references/contract.md` for the full contract and `streams.md` for
stream types, stream metadata and SSE events.

Each stream declares its metadata in `/device.streams`: `unit`, `label`, `kind`
(`measured` or `setpoint`), `width`/`bitLabels` for bits, `rateHz` for sampled
streams, `writable` for byte streams. Byte and frame streams are idle-driven: the
reader thread calls `idle()` after every read return, so the watermark trails the
clock by at most one poll interval (`--check` verifies it).

| Adapter | Streams |
|---|---|
| `pci1710l` | `ai0..15` scalar scan group in V, `measured` (one scan, shared `t`; need `configure_ai`), `di` 16-bit `measured` published on change, `do` 16-bit read back after every write |
| `pci1762` | `di` 16-bit (`IDI0..15`) `measured` published on change, `relay` 16-bit (`R0..15`) coil command read back after every write |
| `pci6208v` | `ao0..7` scalar in V, `setpoint`: the accepted value published on write and every point of a software waveform (`set_waveform`/`stop_waveform`, at most 200 updates/s; `safe_state` stops it) |
| `cp118u_i` | `serial1..8` bytes: RX from a 10 ms reader thread that calls `idle()` after every read, TX via the stream writer, `mark` on configure/clear/flush |

## Inventory: the terminal registry

There is no inventory file in this directory. Computers, services and hardware live
in the HardwareHarness terminal's registry (design 4.7); the SSH password is
`ssh:<computerId>` and each service token `mcp:<serverId>` in the terminal's secret
store. The services currently on the bench computer `192.168.3.63`:

| Adapter | serverId | Install root | hardwareId | Port |
|---|---|---|---|---|
| `pci1710l` | `PCI1710L_MCP` | `E:\pci1710l_mcp_server` | `PC1_MCP.PCI1710L_CARD_0` | 8011 |
| `pci1762` | `PCI1762_MCP` | `E:\pci1762_mcp_server` | `PC1_MCP.PCI1762_CARD_0` | 8012 |
| `pci6208v` | `PCI6208V_MCP` | `E:\pci6208v_mcp_server` | `PC1_MCP.PCI6208V_CARD_0` | 8013 |
| `cp118u_i` | `CP118U_I_MCP` | `E:\cp118u_i_mcp_server` | `PC1_MCP.CP118U_I_CARD_0` | 8014 |

`hardwareId` must equal the id the server reports from `list_hardware`. Services that
were installed before the terminal knew them are added with "从电脑导入", which reads
`C:\ProgramData\HardwareHarness\services.json` on the computer.

The live `server.json` in each remote directory (identity, port, token, `settings`)
is generated by the terminal's deploy on first install, with a random token kept in
the terminal's secret store as `mcp:<serverId>`; upgrades keep the existing file and
reuse its token and port (design 4.7). Nobody writes it by hand, and it is never
committed to this repository, pulled or overwritten.

## Remote install scripts

`install.ps1` (run by the deploy after the files are replaced) creates the venv,
installs the bundled wheels, then:

- records the service in `C:\ProgramData\HardwareHarness\services.json`:
  `{"formatVersion": 1, "services": [{serverId, hardwareId, adapter, adapterVersion,
  root, port, installedAt}]}`, one entry per root, read from `server.json` and
  `build.json`. The registry never contains a token.
- with `-AutoStart` (the default) registers the boot task
  `\HardwareHarness\<serverId>`, which runs `start.ps1` as SYSTEM 30 s after
  startup. Registering needs an elevated session; without one it only warns.
  `-AutoStart:$false` removes the task.

`uninstall.ps1` removes the task and this root's registry entry. The terminal's
uninstall stops the server first and then archives and deletes the directory.

## Assemble

The deploy assembles the bundle itself; to build one without deploying:

```powershell
cd ..\HardwareHarness\python
uv run python -m hardwareharness_backend.devices.deploy adapters
uv run python -m hardwareharness_backend.devices.deploy assemble --server-id PCI1762_MCP `
    --hardware-id PC1_MCP.PCI1762_CARD_0 --adapter pci1762
```

`dist/<serverId>/` contains wheels of the SDK and the adapter plus their offline
dependencies for Python 3.11, 3.12 and 3.13 (`win_amd64`), `requirements.txt`, the
rendered scripts, `server.example.json` and `build.json` (serverId, hardwareId,
adapter, versions, git commit and dirty flag), which `get_server_info` reports as
`sourceRevision`. A bundle never contains `server.json`, `native\` or `app\`.
The source is this directory: `$env:HARDWAREHARNESS_MCP_SOURCE`, else the
`mcp_servers` beside the checkout (`--source` overrides both).

## Deploy

Deploying writes to the real test bench. It runs from the terminal, through one
pipeline (design 4.8.3):

- the Devices page: "部署服务" on a PowerShell computer, "升级" / "卸载" on a
  deployed service (each shows the step list);
- the Agent's deploy tool, which needs the `devices.deploy` capability (not granted
  to agents by default);
- the command line, for maintainers (close the desktop app first; both write the same
  registry):

```powershell
.\deploy.ps1 -Computer PC1 -ServerId PCI1762_MCP -HardwareId PC1_MCP.PCI1762_CARD_0 `
    -Adapter pci1762 -Port 8012          # -Root, -Label, -Settings <json>, -DryRun, -NoAutostart
```

The default root is `E:\<serverid lower>_server`. Progress lines go to stderr and
the final `{"result": ...}` line to stdout; tokens are never printed. The command
line reads the SSH password from the system credential store only.

Each deploy, for one service:

1. `inspect`: reads the root; a `server.json` of another serverId stops the deploy;
2. `config.read` (upgrade: reuse the token and port) or, on first install,
   `config.write` after the upload;
3. `upload` to `{root}\deploy-staging-{stamp}` over SFTP, then `verify` SHA-256;
4. `backup` of the managed files to `{root}\backup\{stamp}`;
5. `stop`: safe shutdown through the registered service; a running service the
   terminal does not know is never stopped blindly;
6. `replace`, `install` (`install.ps1`), `check` (remote `--check`), `start`,
   `health` (`/health` must report this serverId), `device` (`/device` with the token);
7. on any failure after the stop: `rollback.stop`, `rollback.restore`, and with a
   backup `rollback.install` and `rollback.start`. The error names the first failed
   step and whether the previous version came back.

`server.json`, `venv`/`.venv`, `logs`, `run`, `backup`, `.env`, secrets,
credentials and the vendor CLI trees `native\` and `app\` are never replaced,
backed up or deleted. `-DryRun` writes `"dryRun": true` into a new `server.json`, so
the service runs on the adapter's simulated drivers (upgrades keep the existing
file). On success the service is registered (or updated) in the terminal with its token.

Uninstall runs `inspect`, `stop`, `uninstall.write` (only for roots installed
before `uninstall.ps1` was bundled), `unregister`, `archive` (the whole root to
`C:\ProgramData\HardwareHarness\backup\<serverId>-<stamp>.zip`) and `remove`, then
removes the service from the terminal.

