# Project runtime delivery

The frozen backend and user-project interpreter are separate distributions. The project runtime is
CPython 3.11.15 (standalone Windows x64), uv 0.11.32, a zero-dependency `hardwareharness` wheel, and an
offline wheelhouse containing pinned Ruff and test dependencies. It belongs at
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
must collect `hardwareharness_backend.workspace/templates` and
`hardwareharness_backend.mcp_gateway` reference/prompt resources as package data.

The installed application creates `.hardwareharness/.venv` in the project directory. Default setup
uses only the shipped wheelhouse and disables package indexes. Custom dependency installation is an
explicit online operation after Python runs have stopped. Existing project
code and dependency files are never replaced by workspace initialization.

`HARDWAREHARNESS_PROJECT_RUNTIME` can override the resources directory for an isolated packaging
smoke test. It contains no credentials. When packaged, missing runtime resources fail explicitly;
there is no fallback to a machine's Python installation.

Release verification must create a fresh default project under a Chinese/spaced path, prepare it
without network or machine Python/uv on PATH, run a sample Python program, then stop and verify all
child processes exited. This local test supplements an independent clean Windows
installation test; neither should be reported as completed before it is actually executed.

The release Agent interface has no dependency on the HH development checkout. A fresh installed
project obtains the current SDK guide through `read_reference`, discovers precise tool and SDK
contracts through `get_tool_contract`, and creates its first program through `create_workspace_file`.
The guide shipped with the current app is authoritative; a previously generated project document
may describe an older contract. Use `get_agent_context` to check the installed versions and reference
revision before copying examples.

The SDK keeps the original MCP envelope by default. New code may explicitly request
`result_mode="data"` on `call` and `acall`; it must still follow the selected tool's data schema.
Raw tool output and media evidence remain available in Run events and artifacts. Static validation,
successful program completion, and successful physical acceptance are different facts.

The desktop compiles the shared `mcp_gateway/agent-instructions.md` into its main bundle and injects
it through OpenCode's supported `agent.build.prompt` and `agent.plan.prompt` configuration.
The backend loads the same packaged resource for MCP initialize instructions. The Windows
`opencode-agent-contract.test.ts` executes the pinned OpenCode binary's `debug config` and
`debug agent build` commands in isolated temporary storage to verify the resolved prompt without
contacting a model or hardware. This proves configuration acceptance, not live Agent task quality.

`apps/desktop/scripts/smoke-agent-frozen.mjs` accepts a frozen backend directory, project-runtime
directory, output report path and optional rebuilt SDK wheel. It copies the supplied release
resources into an unrelated temporary directory, removes machine Python/uv from PATH, initializes
a Chinese/spaced project offline, then uses only public MCP tools for guide/contract discovery,
script creation, stale-write rejection, validation, execution, waiting, event pagination, source
snapshot and attachment reads. The desktop protocol is used only to bootstrap the profile/project.
The program deliberately returns `passed=false` with status `succeeded` to check that these facts
remain distinct. The report records that no hardware was invoked and no live model was assessed.
