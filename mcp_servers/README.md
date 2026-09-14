# Real hardware MCP servers

本机 FireDAP 烧录服务见 [`servers/firedap/README.md`](servers/firedap/README.md)，
霸天虎 V2 常用接口模型见 [`hardware-manuals/stm32-batianhu-v2/README.md`](hardware-manuals/stm32-batianhu-v2/README.md)。
FireDAP 使用独立的本地安装/注册脚本，不属于下述四台 PCI/串口服务的远程同步清单。

This directory is the source-controlled mirror of the four MCP servers running on
`192.168.3.63`. Runtime state, virtual environments, logs, backups and credentials
are deliberately excluded.

## Pull the current remote source

```powershell
.\pull.ps1
```

Pull one server only:

```powershell
.\pull.ps1 -Server pci1710l
```

Pull refuses to overwrite local source changes. Use `-Force` only when the remote
copy is intentionally the source of truth.

The command reads the SSH credential from TestForge Electron `safeStorage`. For CI
or a maintenance workstation without the TestForge credential store, set
`TESTFORGE_REMOTE_PASSWORD` for the current process before invoking the script.

Each server directory contains a credential-free `server.example.json` for local
tests and source review. Run all four local test suites with:

```powershell
.\test.ps1
```

## Deploy

```powershell
.\deploy.ps1
```

Deployment is sequential and isolated per server. For each server it:

1. refuses to interrupt a currently occupied hardware device;
2. uploads to a staging directory and verifies SHA-256 hashes;
3. creates `source-backup-<timestamp>` on the remote computer;
4. stops only that MCP server and replaces the managed source files;
5. runs the remote `app/tests` suite;
6. starts the server and verifies `/health`;
7. restores only that server's backup if tests, startup or health checks fail.

Use `-Server` to deploy one server. `-SkipTests` is available for an emergency
maintenance window, but the default is to run tests. `-ForceOccupied` is an
explicit emergency override that may interrupt active hardware work.

## Verify local and remote hashes

```powershell
.\verify.ps1
```

Managed source files include Python, PowerShell, JSON/TOML/YAML and documentation
files. `.env`, credentials, certificates, private keys, virtual environments,
logs, runtime state, generated `*.egg-info`, caches, staging directories and
backups are never pulled or deployed. Each live `server.json` contains
machine-specific runtime configuration and authentication material, so it is also
left untouched on the remote computer.
