# TestForge VISA/SCPI MCP Server template

This template binds one MCP process to one VISA resource and therefore one hardware instrument. It uses the shared TestForge Python runtime and PowerShell lifecycle scripts.

## Get the template

For a standalone copy, run `pnpm package:templates` at the repository root and extract `output/mcp-templates/testforge-visascpi-server-template.zip`. The ZIP contains its own `runtime/`; copying only `mcp_templates/visascpi_server` from the repository does not.

Repository contributors can work in place because the wrapper scripts fall back to the adjacent `mcp_templates/runtime/` directory.

## Configure and run

1. Copy `server.json.example` to `server.json`; set stable IDs, VISA resource, expected `*IDN?` substring, port and a high-entropy token.
2. Add safe-stop SCPI commands and typed instrument tools. Raw `scpi_write`, `scpi_query` and bounded `scpi_query_binary` are provided for bring-up.
3. Make the safe-stop command sequence idempotently disable outputs or motion before shutdown.
4. Run `install.ps1`, then `start.ps1`. Use `status.ps1` and `stop.ps1` for lifecycle management.

The default host is `127.0.0.1`. Keep it on loopback and use an SSH tunnel or VPN for remote access. A non-loopback host is rejected unless `allowInsecureRemote` is explicitly true; that opt-in does not add TLS.

`stop.ps1` exits the process only after safe-stop succeeds. If safe-stop fails, the request times out, or the process does not exit in time, the process is left running for inspection instead of being force-killed.

Binary replies are capped at 1 MiB by default. Add an MCP Resource or an artifact store for oscilloscope captures and other large data instead of placing them directly in tool results.
