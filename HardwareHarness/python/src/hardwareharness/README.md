# hardwareharness Python SDK

The SDK exposes only hardware calls and structured logging. Launch workflows from HardwareHarness;
an ordinary Python interpreter without a platform launch cannot connect to hardware through this SDK.
Device discovery, documentation, wiring, human confirmation and occupancy are managed by the Agent
and the existing HardwareHarness interfaces. Scripts do not request or release occupancy.

## Workflow entry points

Save a Python file under the project's `.hardwareharness/workflows/` directory. Define `main(inputs)`;
the function may be synchronous or asynchronous. Inputs and return values must be JSON-compatible.
The launch configuration declares hardware IDs and input JSON Schema outside the business code.

```python
from hardwareharness import call, measurement, step


def main(inputs):
    with step("Read voltage"):
        response = call("board-id", "discovered-tool-name", {"channel": inputs["channel"]})
        # Tool names, arguments and output shapes come from the device's discovered schema.
        value = response["structuredContent"]["data"]["value"]
        measurement("voltage", value, unit="V")
        return {"voltage": value}
```

Every Run executes in a separate process from a saved code snapshot. Editing the workspace does not
change that Run. A Web application's business buttons each create a separate Run; its FastAPI server
does not have hardware invocation credentials.

## Public functions

| Function | Behavior |
| --- | --- |
| `call(hardware_id, tool_name, arguments, *, timeout_ms=None)` | Invoke a declared active hardware tool synchronously. |
| `await acall(...)` | The same invocation without blocking the workflow event loop. |
| `step(name)` | A synchronous/asynchronous context manager or a function decorator. Each invocation gets a distinct step. |
| `log(message, *, level="info", fields=None)` | Record a structured message and optional JSON fields. |
| `measurement(name, value, *, unit=None)` | Record a numeric measurement and optional unit. |
| `attachment(path, *, name=None, media_type=None)` | Copy a file into the Run's artifacts and record its hash. |

Hardware responses retain the complete MCP result, including `content` and `structuredContent` when
provided. Existing device input/output validation and error normalization still apply. A structured
device envelope may put its business value under `structuredContent.data`; check the discovered
schema instead of assuming a universal result shape.

Timeouts default to 30,000 milliseconds and accept integers from 100 to 1,800,000. Missing or expired
occupancy, passive hardware, hidden management tools and undeclared hardware produce explicit errors.
The platform does not acquire occupancy, queue authorization requests or replay hardware calls.
Concurrent calls to different hardware are allowed. Overlapping calls to the same hardware return a
conflict, including overlaps inside one Run; await such operations in order.

## Logs and cancellation

Nested and repeated steps form the execution tree. Asynchronous tasks inherit their parent step;
ordinary user-created threads without an inherited context log at the Run root. Hardware operations,
standard output/error, exceptions and durations are recorded automatically. Large hardware results
are kept as downloadable artifacts while the original result is returned to the script.

Cancellation interrupts an asynchronous entry point and is delivered to synchronous code at the next
SDK hardware-call boundary. Use Python `try/finally` for cleanup. The cleanup grace period is ten
seconds, after which the platform terminates the process tree; forced termination cannot execute
`finally`. Cleanup calls still require a valid occupancy lease. A timed-out or cancelled remote
operation may already have acted on hardware, so its result is explicitly unknown and is never retried.

After a platform restart, unfinished runs are marked interrupted. Their saved events and source
snapshots remain inspectable; arbitrary Python call stacks are not resumed.
