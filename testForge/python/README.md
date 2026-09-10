# TestForge Python backend

This directory ports the eight TypeScript domain packages. TypeScript originals remain the
reference implementation and test oracle. The desktop uses a private bidirectional stdio
JSON-RPC connection; the existing external MCP endpoint remains Streamable HTTP.

Final implementation, verification evidence, compatibility notes, approved deviations,
and installer hashes are indexed in [the delivery report](reports/implementation.md).

```powershell
uv sync --frozen
uv run python scripts/prepare_icu.py
uv run ruff check src tests scripts
uv run ruff format --check src tests scripts
uv run mypy --strict
uv run pytest --cov --cov-report=json:reports/python-coverage.json
uv run python scripts/protected_baseline.py check
uv run pyinstaller --noconfirm backend.spec
```

From the `testForge` workspace root, `pnpm python:setup` restores the locked Python
environment and ICU binary. `pnpm verify:python` runs lint, formatting, strict typing,
pytest branch coverage, all 117 specification mappings, coverage floors and protected
file hashes. `pnpm verify` keeps the TypeScript gates; `pnpm verify:full` runs both and
Electron E2E. `pnpm package:win` builds the backend, production app and x64 NSIS installer.

Development uses `.venv/Scripts/python.exe`. The Windows package contains the complete
`dist/testforge-backend` directory under `resources/backend`, including ICU 74.2 and its
license. The executable keeps console streams enabled; Electron spawns it with a hidden
window. No Python, uv, network access, or writable installation directory is needed at runtime.

For a frozen smoke run, set `TESTFORGE_BACKEND_EXECUTABLE` to the absolute backend executable
and `TESTFORGE_BACKEND_ISOLATED_ENV=1`, then run `uv run pytest tests/host/test_process.py`.
For installed Electron, set `TESTFORGE_DESKTOP_EXECUTABLE` and run the desktop Playwright
`e2e/python-backend.spec.ts`; the app's PATH contains only Windows System32 in that mode.
These checks isolate runtime dependencies on this Windows host; they are not a substitute
for an independent clean Windows VM acceptance run.

`reports/protected-files.json` records the original renderer, OpenCode and integration
dependency hashes. The only renderer exception authorized during implementation is the
existing `LogsPage.tsx` hooks lint correction recorded separately in
`reports/protected-exceptions.json`.

Domain JSON continues to use camelCase. The process envelope uses an unambiguous tagged
codec for bytes, undefined, dates and special numbers. Ciphertext files stay owned by Python,
while Electron safeStorage handles encryption through synchronous reverse calls completed
by a dedicated Python pipe reader thread. Credentials and protocol payloads are not logged.
