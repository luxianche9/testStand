# HardwareHarness Python SDK

SDK version: 0.1.0. Contract revision: 2026-09-15.1. Retrieve the current bundled copy with
`read_reference(referenceId="hh-sdk")`; an existing project's edited guide is not replaced on upgrade.

## Project and execution

Use `get_agent_context` for the current project, Python environment and effective policy.
The platform runs saved Python programs under `.hardwareharness/scripts/` in separate processes.
Create the first file with `create_workspace_file(path="scripts/main.py", content=...)`.
For updates first read its `hash`, then pass it as `expectedHash` to `write_workspace_file`.
The public path starts with `scripts/`, not `.hardwareharness/`. Only UTF-8 Python files up to 4 MiB
are editable; subdirectories are supported. Each entrypoint defines synchronous or asynchronous
`main(inputs)`. Inputs and return values must be JSON-compatible. Dependencies belong to the project's
environment; `initialize_workspace` prepares it using the installed runtime and bundled wheels.
It must finish before running code. Dependency changes require all Python runs to stop.

Discover the registered hardware, read `get_tool_contract(toolName=...)`, resolve any required wiring,
and check `get_execution_availability` before starting. `start_python_run` takes the saved entrypoint,
JSON inputs, input JSON Schema and the exact `hardwareIds` that code will use. A successful start
only accepts the Run. Inspect its terminal state and business return value using
`get_python_run_summary` and `get_python_run_events`; use `wait_for_status(kind="run", id=...)` to
wait without launching a second Run. Process `succeeded` does not imply a business `passed=true`.
Every Run uses an immutable source snapshot, which `read_python_run_source` can inspect.

## call and acall

`call(hardware_id, tool_name, arguments, *, timeout_ms=None, result_mode="envelope")` invokes one
declared, available hardware tool. `await acall(...)` is its asynchronous equivalent.
Use the exact SDK tool name returned by the public contract, not an OpenCode client-added prefix.
Timeouts default to 30,000 ms and accept integers from 100 to 1,800,000 ms. Hardware must be declared
in the Run's `hardwareIds`. Passive, offline, unknown, hidden internal and undeclared hardware
operations fail. Concurrent calls to different hardware are allowed; overlapping calls on the same
hardware return a conflict, including overlaps inside one Run. Await them in order.

The default `result_mode="envelope"` preserves the existing complete MCP result:

```json
{"content":[{"type":"text","text":"{\"ok\":true,\"data\":{\"volts\":1.23}}"}],
 "structuredContent":{"ok":true,"data":{"volts":1.23}},"isError":false}
```

This is a contract example, not a measurement. The raw result can contain images, audio, resources,
and extra metadata. It is retained by the Run before any SDK selection. Large results are stored as
artifacts. Agent tool responses use the gateway's `ok/data` envelope, which is a different surface.

New code can request `result_mode="data"`: select `structuredContent` if present; otherwise parse a
single JSON text content block when possible; unwrap `{ok:true,data:...}` exactly once. Unwrapped
structured values are returned unchanged. Non-JSON or multiple text/media blocks stay in the full
envelope, so inspect the contract when data is not structured. `isError=true` or selected
`ok=false` raises a `RuntimeError` subtype with `category` and `details`. Transport errors also raise.
The default envelope behavior remains unchanged for existing code. An invalid result mode is rejected
before any hardware action. Full evidence and media remain retrievable with `read_python_run_artifact`.

## Structured logging

The library exposes exactly six public functions:

| Function | Contract |
| --- | --- |
| `call(...)` | Synchronous hardware call; result modes described above. |
| `await acall(...)` | Same result/error contract; async does not bypass device serialization. |
| `step(name)` | Nonempty name; synchronous/asynchronous context manager or decorator. Use an independent block per concurrent invocation. The step succeeds when its body returns without an exception; it does not decide business pass/fail. |
| `log(message, *, level="info", fields=None)` | Records a message, level string, optional JSON fields and source location. Use conventional info/warning/error/debug levels. Fields and outputs must not contain credentials. |
| `measurement(name, value, *, unit=None)` | Records a finite JSON number and optional unit. Distinguish commanded, cached and measured names. Logging a number does not evaluate a limit or prove physical behavior. |
| `attachment(path, *, name=None, media_type=None)` | Copies an existing file accessible to the Run process into its artifacts and records SHA-256/size. `name` is a filename, not a directory. No published attachment size limit is enforced by this SDK; keep outputs bounded. Delete temporary files only after this call succeeds. |

Standard output/error, exceptions, calls and durations are recorded automatically. SDK logging requires
a platform-launched process. Ordinary project Python is trusted local code, not an operating-system
sandbox. It cannot use this SDK to call hardware outside a platform launch.

## Pure computation example

This script needs no hardware declarations and verifies only its own arithmetic:

```python
from hardwareharness import log, measurement, step


def main(inputs):
    with step("Calculate mean"):
        samples = inputs["samples"]
        if not samples:
            raise ValueError("samples must not be empty")
        mean = sum(samples) / len(samples)
        measurement("calculated_mean", mean)
        log("Calculation complete", fields={"sample_count": len(samples)})
        return {"mean": mean, "sample_count": len(samples)}
```

## Hardware flow and cleanup

This example uses runtime inputs containing exact discovered hardware IDs, tool names and arguments.
Before running, validate those tools' contracts and the load's allowed stimulation and cleanup state.
The desired safe state is an explicit input; it is not inferred to mean zero volts.

```python
from hardwareharness import call, log, step


def main(inputs):
    hardware_id = inputs["hardware_id"]
    try:
        with step("Apply configured output"):
            applied = call(
                hardware_id, inputs["apply_tool"], inputs["apply_arguments"], result_mode="data"
            )
        log("Output command completed", fields={"command_result": applied})
        return {"command_result": applied}
    finally:
        with step("Restore configured safe state"):
            call(
                hardware_id, inputs["cleanup_tool"], inputs["cleanup_arguments"], result_mode="data"
            )
```

Command success is not physical readback. Use a separate measurement channel and explicit limits
when the task requires a pass/fail conclusion. Check recorded events after every real Run.
The platform never replays a hardware call. A timeout, cancellation or lost connection can leave
the physical result unknown. Query status/evidence before deciding on any further action.
Cancellation interrupts asynchronous code or reaches synchronous code at the next SDK call boundary.
`try/finally` can clean up during the ten-second grace period; forced termination cannot execute it.
Cleanup calls still require an available device. After a restart unfinished Runs are marked
`interrupted`; saved evidence remains readable and arbitrary Python execution is not resumed.
