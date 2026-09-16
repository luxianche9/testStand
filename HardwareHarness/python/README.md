# HardwareHarness Python backend

The Python backend owns devices, projects, wiring, reference documents and the public MCP gateway.
Electron calls it through a private bidirectional stdio JSON-RPC connection. External Agents use
Streamable HTTP MCP. The retired test-flow editor, Python script runner, run logs and bundled SDK
are no longer part of the backend or Windows package.

From the application workspace (`HardwareHarness`):

```powershell
pnpm python:setup
pnpm verify:python
pnpm build:python
```

`verify:python` runs Ruff lint/format, strict mypy, all pytest tests, and per-package line/branch
coverage checks. `coverage-baseline.json` retains the previous thresholds for supported packages;
reference storage requires 90% line and branch coverage. Coverage output is written to
`../output/verification/`, which is ignored by Git. Verification does not require historical delivery
reports. Contract golden fixtures remain under `tests/` alongside current API and migration tests.

The package contains `dist/hardwareharness-backend` under `resources/backend`, including ICU and its
license. Electron starts the backend with a hidden window and dedicated stdin/stdout pipes.
No user-script Python runtime, SDK wheel or uv executable is shipped.

For a frozen backend smoke check, set `HARDWAREHARNESS_BACKEND_EXECUTABLE` and
`HARDWAREHARNESS_BACKEND_ISOLATED_ENV=1`, then run `uv run pytest tests/host/test_process.py`.
For installed Electron, set `HARDWAREHARNESS_DESKTOP_EXECUTABLE` and run
`e2e/python-backend.spec.ts`. These are local Windows checks, not an independent clean-VM acceptance.

Domain JSON uses camelCase. The process codec preserves bytes, undefined, dates and special numbers.
Python owns ciphertext files; Electron safeStorage performs encryption via reverse calls on a
separate pipe reader. User project files and historical backups are preserved during feature removal.
