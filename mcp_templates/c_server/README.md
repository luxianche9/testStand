# TestForge C/C++ SDK MCP Server template

This template intentionally maps one process to one stable `serverId` and one `hardwareId`. It uses the shared TestForge Python runtime and PowerShell lifecycle scripts.

## Get the template

For a standalone copy, run `pnpm package:templates` at the repository root and extract `output/mcp-templates/testforge-c-server-template.zip`. The ZIP contains its own `runtime/`; copying only `mcp_templates/c_server` from the repository does not.

Repository contributors can work in place because the wrapper scripts fall back to the adjacent `mcp_templates/runtime/` directory.

## Configure and run

1. Copy `server.json.example` to `server.json` and set the stable identity, port and a high-entropy token.
2. Implement `HardwareDriver` in `app/src/testforge_server/hardware.py`.
3. Replace the sample `read_status` and `set_output` tools with hardware-specific typed tools. Hardware calls are serialized by the driver/runtime locks.
4. Make `safe_stop()` idempotently put the physical device into a safe state.
5. Run `install.ps1`, then `start.ps1`. Use `status.ps1` and `stop.ps1` for lifecycle management.

The management contract always exposes `get_server_info`, `list_hardware`, `get_hardware_info` and safe shutdown. `list_hardware` must return exactly one item.

The default host is `127.0.0.1`. Keep it on loopback and use an SSH tunnel or VPN for remote access. A non-loopback host is rejected unless `allowInsecureRemote` is explicitly true; that opt-in does not add TLS.

`stop.ps1` exits the process only after `safe_stop()` succeeds. If safe-stop fails, the request times out, or the process does not exit in time, the process is left running for inspection instead of being force-killed.

A Server implements the vendor SDK and nothing else. Ports, pins and connector photos are authored in TestForge's Device Management page and stored there, so a device can be registered while this Server is offline.
