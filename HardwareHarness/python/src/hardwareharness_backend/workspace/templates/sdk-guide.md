# HardwareHarness project development

Use the platform to inspect device schemas, resolve wiring and obtain occupancy before running code.
The Python library does not acquire devices, create wiring requests or manage projects.

```python
from hardwareharness import call, log, measurement, step


def main(inputs: dict[str, object]) -> dict[str, object]:
    with step("Measure"):
        result = call("registered-hardware-id", "advertised-tool-name", {"channel": 0})
        log("Measurement received", fields={"result": result})
        measurement("sample_count", 1, unit="samples")
        return {"result": result}
```

`acall` is the asynchronous version. `step` supports synchronous/asynchronous context blocks and
decorators. `attachment(path, name=..., media_type=...)` copies an output file into the Run record.
Run inputs and return values must be JSON; record file outputs as attachments.
Hardware tools retain their advertised result shape. Inspect tools instead of inventing methods.

Start with mock-device tests. Check the recorded events after every real run. Missing occupancy and
conflicting hardware fail immediately. Never retry a hardware operation merely because its result is
unknown. Cancelling a process does not undo physical actions; cleanup still requires valid occupancy.

An application lives in `apps/<id>` and provides `app.json`, `server.py` and `web/`. Its actions refer to
Python workflow entrypoints relative to `.hardwareharness`. The application server renders pages;
the platform launches a separate process and Run for each action. Browser action requests use
`/__hardwareharness/actions/<id>`, Run status/cancel/events use `/__hardwareharness/runs/<runId>`.
Application-server output is separate from Run output.

The SDK works only inside platform-launched workflow processes. Local Python is ordinary trusted
project code, not an operating-system sandbox. The Web preview has no Electron desktop bridge.
