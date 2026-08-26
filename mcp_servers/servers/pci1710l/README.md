# TestForge C/C++ SDK MCP Server template

This template is intentionally one process, one `serverId`, and one `hardwareId`.

1. Copy the directory and rename it for the hardware.
2. Copy `server.json.example` to `server.json` and fill in the stable identity, port and token.
3. Implement `HardwareDriver` in `app/src/testforge_server/hardware.py` and the static pinout in `pinout.py`.
4. Replace the sample `read_status` and `set_output` tools with hardware-specific tools. Every real hardware tool must require a lease.
5. Run `python -m venv venv`, `venv\\Scripts\\python -m pip install -e app`, then `venv\\Scripts\\python -m testforge_server` from the Server root.

The management contract always exposes `get_server_info`, `list_hardware`, `get_hardware_info`, `get_pinout`, acquire/release and safe shutdown. `list_hardware` must return exactly one item.
