# Hardware lease removal

The user requested removal of the entire hardware ownership system on 2026-09-15 for single-user LAN development.

Hardware tools now execute directly when their device is available. Removed the desktop acquisition/release controls, ownership status badges, AI request dialog and mailbox entries, IPC/preload contracts, gateway request tools and capabilities, Python ownership manager, heartbeat tasks, remote registries, expiry handling and lease metadata. Updated all four PCI/serial service copies and FireDAP, as well as deployment tooling, SDK documentation and Agent instructions.

In-flight execution coordination, device availability checks, cancellation and remote safe shutdown remain. The execution coordinator's local resource handle has no expiry or renewal and is now named `ExecutionHandle`.

## Validation

- Desktop/contracts: 234 unit tests passed; TypeScript, ESLint, dependency/import boundaries and branding checks passed.
- Python: complete `scripts/verify.py` passed, including 903 tests, formatting, strict typing, coverage floors, retained specification mappings and protected-source checks.
- PCI1710L, PCI1762, PCI6208V and CP118U-I: 8 tests per service passed using example configuration and simulated hardware operations.
- FireDAP: 36 tests passed with a simulated hardware worker.
- Desktop end-to-end: 3 tests passed for direct manual hardware calls, persisted Python Run logs, and direct AI hardware calls without an ownership request.
- Production build passed. The automated tests above used simulated hardware; subsequent real-device deployment and checks are recorded below.

`changes.json` records the four retired ownership specifications and the three affected protected device source files. Historical test evidence remains unchanged.

## Real-device deployment — 2026-09-15

All four remote MCP services on `192.168.3.63` were deployed and restarted. Remote tests and health checks passed; source verification matched all 31 deployed files for each service.

| Service | Port | Backup in the service root |
| --- | --- | --- |
| PCI1710L | 8011 | `source-backup-20260915021715` |
| PCI1762 | 8012 | `source-backup-20260915021819` |
| PCI6208V | 8013 | `source-backup-20260915021908` |
| CP118U-I | 8014 | `source-backup-20260915022004` |

Local FireDAP on port 8015 was restarted using the updated workspace installation. The desktop production build was launched with its Python backend and gateway on port 8000. The desktop reports all five MCP transports online. Direct read-only calls succeeded for all four remote devices and through the desktop gateway without acquiring a lease. Occupancy tools, preload APIs and dashboard fields are absent.

During initial deployment, FireDAP detected the USB probe, and the target-information job was accepted without a lease. STM32 communication failed with `SWD/JTAG communication failure (No ACK)` and the device state became `faulted`. The MCP service remained online. No firmware was flashed or MCU reset requested. A later user-requested check recovered successfully, as recorded below.

See `live-verification.json` for the completed checks and `firedap-diagnostic.json` for the target failure. In the live report, `ok: true` means deployment and API verification succeeded; `physicalChecksPassed: false` explicitly records the FireDAP limitation. The desktop remains running for use.

Deployment tooling now installs its own pinned SSH dependency under `mcp_servers/tools` and locates the current desktop credential directory. Existing remote source backups were retained. No compatibility acquisition or renewal path is retained.

## FireDAP recovery and consistent device status — 2026-09-15 11:21 CST

After the user reported that the target board may previously have been powered off, an explicit attach-only target identity check succeeded. It read device ID `0x101f6413`, 1024 KiB Flash and a running core. The service cleared `lastError` and changed from `faulted` to `open` without a restart. See `firedap-recovery.json`; the original deployment report remains historical evidence.

The display disagreement was caused by different predicates: device management labelled an online MCP transport as online even when hardware was faulted, while the wiring library labelled every non-available/non-checking hardware state as offline. Both views now use one shared hardware-status function. Faulted hardware displays `故障` with its diagnostic, disconnected services display `离线`, and healthy hardware displays `在线`. Device details also use this status instead of a second raw English availability badge.

Seven device UI tests passed, including regressions comparing wiring and device-management output for a target fault, recovery, and transport loss with stale available hardware. Desktop type checking, targeted ESLint and the production build passed. The running desktop backend confirms FireDAP is open. The current project has unsaved changes, so the desktop was kept running; the newly built display logic will load on the next desktop start.
