# Hardware MCP servers

本机 FireDAP 烧录服务见 [`servers/firedap/README.md`](servers/firedap/README.md)（仍是旧布局，尚未迁入 SDK），
霸天虎 V2 常用接口模型见 [`hardware-manuals/stm32-batianhu-v2/README.md`](hardware-manuals/stm32-batianhu-v2/README.md)。
新硬件服务按技能 [`skill/mcp-server`](../skill/mcp-server/SKILL.md) 编写。

Each hardware MCP server is the device SDK plus one adapter. The four boards on
`192.168.3.63` (PCI-1710L, PCI-1762, PCI-6208V, CP-118U-I) are built from this
directory; the remote directories are deployment artifacts, not source.

```
sdk/                     hardwareharness_device_sdk: transport, auth, builtin tools, envelope,
                         lifecycle, safe_state, streams (ring buffer + WebSocket), panel, compliance
adapters/<adapter>/      hh_adapter_<adapter>: adapter.py, driver.py, sim.py, pinout.py, panel.py, tests/
templates/*.ps1          install / start / stop / status / runner, rendered per server
tools/assemble.py        builds dist/<id>/ from sdk + one adapter + offline wheels + scripts
tools/remote-source.cjs  SSH deploy / pull / verify
servers.json             the server inventory (no secrets)
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

`HARDWARE_DRY_RUN_AI_NOISE=1` makes simulated analog inputs move and
`HARDWARE_DRY_RUN_SERIAL_LOOPBACK=1` echoes serial TX back to RX, for demonstrating
canvas widgets. Both are off by default so simulated inputs read idle values.

## Service contract

| Path | Purpose |
|---|---|
| `/mcp` | Streamable HTTP MCP, `Authorization: Bearer <token>` |
| `/health` | Unauthenticated health: `{healthy, serverId, hardwareId, state, sdkVersion}` |
| `/admin/shutdown` | Authenticated safe shutdown (`safe_state`, then exit) |
| `/streams/{streamId}?from=<cursor or -N>` | Read-only WebSocket data channel, same token |

Builtin tools: `get_server_info`, `list_hardware`, `get_hardware_info`, `get_pinout`,
`list_streams`, `get_panel`, `<prefix>_stream_read`, `<prefix>_stream_start`,
`<prefix>_stream_stop`, `hardwareharness_prepare_shutdown`. Device tools keep their
previous names and arguments; each declares `operationSemantics` explicitly. See
`skill/mcp-server/references/contract.md` for the full contract and
`streams-and-panel.md` for the stream frames and widget templates.

| Adapter | Streams | Panel |
|---|---|---|
| `pci1710l` | `ai0..15` sampled volts (need `configure_ai`), `di` and `do` sampled readback bitmaps | AI readouts, DI lamps, DO toggles, `configure_ai` form, safe state |
| `pci1762` | `di` and `relay` sampled readback bitmaps | relay toggles and bank, DI lamps, safe state |
| `pci6208v` | `ao0..7` last accepted value (software shadow) | AO number inputs, safe state |
| `cp118u_i` | `serial1..8` byte streams (RX from a 10 ms reader thread, TX as accepted) | serial terminals, safe state |

## Inventory: `servers.json`

`computer` holds the SSH host, user and `credentialKey` (`ssh:REMOTE_PC_1`). Each
entry in `servers` has:

| Field | Meaning |
|---|---|
| `id` | Short id used by every script (`-Server <id>`) |
| `label` | Display name |
| `serverId` | MCP server id registered in HardwareHarness |
| `adapter` | Directory under `adapters/` |
| `remoteRoot` | Install directory on the remote computer |
| `hardwareId` | Must equal the id the server reports from `list_hardware` |
| `mcpUrl` / `healthUrl` | Service endpoints |
| `mcpCredentialKey` | Secret-store key of the bearer token (`mcp:<serverId>`) |

The live `server.json` on each remote directory (port, token, `settings`) is
maintained by a person on that machine. It is never committed, pulled or deployed.

## Assemble

```powershell
uv run python tools\assemble.py pci1710l
uv run python tools\assemble.py all
```

`dist/<id>/` contains the SDK, one adapter, offline wheels for the remote Python
versions, the rendered scripts and `build.json` (git commit, dirty flag, SDK
version), which `get_server_info` reports as `sourceRevision`. The remote
`native/` build trees are excluded; vendor binaries such as `hwcli_*.exe` stay on
the remote computer and are found through `settings.hwcliPath` or the default
search paths.

## Deploy

Deploying writes to the real test bench. Only a person runs it.

Install the deployment tool's SSH dependency once from the repository root:

```powershell
npm ci --prefix mcp_servers/tools
```

```powershell
.\deploy.ps1 -Server pci1710l      # assembles first; -NoAssemble uploads the existing dist\<id>
```

For each server, one at a time, it:

1. uploads `dist/<id>` to a staging directory and verifies SHA-256 hashes;
2. creates `source-backup-<timestamp>` on the remote computer;
3. stops only that MCP server (safe shutdown) and replaces the managed files;
4. runs the remote dry-run compliance check (`--check`);
5. starts the server and verifies `/health`;
6. restores only that server's backup if the check, startup or health fails.

`-SkipTests` skips step 4 for an emergency maintenance window. The first deploy
of an SDK bundle needs Python 3.11 or newer in the remote virtual environment.

The scripts read the SSH credential from the HardwareHarness Electron `safeStorage`.
On a maintenance workstation without that store, set `HARDWAREHARNESS_REMOTE_PASSWORD`
for the current process first.

## Verify and pull

```powershell
.\verify.ps1                        # compare dist\<id> with the remote hashes
.\pull.ps1 -Server pci1710l         # emergency only: fetch the remote copy into dist\pulled\
```

`.env`, credentials, certificates, private keys, virtual environments, logs,
runtime state, caches, staging directories, backups and `server.json` are never
pulled or deployed.

## After deploying

Register the server as a draft in HardwareHarness, then call each tool by hand
with no load attached: check AI readings against a meter, serial ports with a
loopback cable, relays by their click, and AO outputs followed by `safe_state`.
Only then connect the device under test.
