# Project runtime delivery

The frozen backend and user-project interpreter are separate distributions. The project runtime is
CPython 3.11.15 (standalone Windows x64), uv 0.11.32, a zero-dependency `hardwareharness` wheel, and an
offline wheelhouse containing pinned FastAPI, Uvicorn, Ruff and test dependencies. It belongs at
`resources/project-runtime` beside the frozen backend directory. Never run user scripts by invoking
the PyInstaller executable as though it were Python.

Build the SDK for development:

```text
uv run python scripts/build_project_runtime.py --sdk-only
```

Build the complete runtime on Windows x64, with internet access during the build:

```text
uv run python scripts/build_project_runtime.py
```

The builder records every delivered file hash in `dist/project-runtime-v1/manifest.json`. The installer
must copy the complete directory, including Python's standard library and DLLs. The frozen backend
must collect `hardwareharness_backend.workspace/templates` as package data.

The installed application creates `.hardwareharness/.venv` in the project directory. Default setup
uses only the shipped wheelhouse and disables package indexes. Custom dependency installation is an
explicit online operation after applications and workflow processes have stopped. Existing project
code and dependency files are never replaced by workspace initialization.

`HARDWAREHARNESS_PROJECT_RUNTIME` can override the resources directory for an isolated packaging
smoke test. It contains no credentials. When packaged, missing runtime resources fail explicitly;
there is no fallback to a machine's Python installation.

Release verification must create a fresh default project under a Chinese/spaced path, prepare it
without network or machine Python/uv on PATH, run the sample workflow and FastAPI application, then
stop and verify all child processes exited. This local test supplements an independent clean Windows
installation test; neither should be reported as completed before it is actually executed.
