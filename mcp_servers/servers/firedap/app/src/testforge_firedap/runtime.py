from __future__ import annotations

import asyncio
import json
import sys
import time
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .firmware import OperationError, encode_segments, inspect_firmware
from .diagnostics import validate_sram_read


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ok(data: object) -> dict:
    return {"ok": True, "data": data, "meta": {"timestamp": now()}}


def error(exc: Exception) -> dict:
    return {"ok": False, "error": {"category": getattr(exc, "category", "internal"),
            "message": str(exc), "retryable": False}, "meta": {"timestamp": now()}}


async def run_worker(request: dict, timeout: float) -> dict:
    # pyOCD discovers pyocd_user.py in its project directory independently of no_config.
    # An empty per-operation working directory prevents ambient project scripts/config.
    with tempfile.TemporaryDirectory(prefix="testforge-firedap-") as workdir:
        return await _run_worker_in_directory(request, timeout, workdir)


async def _run_worker_in_directory(request: dict, timeout: float, workdir: str) -> dict:
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "testforge_firedap.worker", cwd=workdir,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(json.dumps(request).encode()), timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        process.kill()
        await process.wait()
        raise OperationError("Hardware worker timed out or stopped; target state is unknown. Inspect before retrying", "operation_interrupted")
    if process.returncode != 0:
        raise OperationError(stderr.decode(errors="replace")[-4000:], "device_unreachable")
    try:
        result = json.loads(stdout)
    except ValueError as exc:
        raise OperationError("Invalid response from hardware worker", "invalid_response") from exc
    if not result.get("ok"):
        raise OperationError(result["error"]["message"], result["error"]["category"])
    return result["data"]


class Runtime:
    """Lease metadata stays responsive while a single non-interruptible job runs."""

    def __init__(self, config: dict, runner=run_worker):
        self.config = config
        self.runner = runner
        self.lock = asyncio.Lock()
        self.lease: dict | None = None
        self.jobs: dict[str, dict] = {}
        self.task: asyncio.Task | None = None
        self.draining = False
        self.probe_present = False
        self.last_error: dict | None = None

    @property
    def busy(self) -> bool:
        return self.task is not None and not self.task.done()

    def check_id(self, hardware_id: str) -> None:
        if hardware_id != self.config["hardwareId"]:
            raise OperationError("Unknown hardwareId")

    def expire(self) -> None:
        if self.lease and self.lease["deadline"] <= time.monotonic() and not self.busy:
            self.lease = None

    def status(self) -> dict:
        self.expire()
        if self.lease is None:
            return {"state": "unoccupied"}
        return {"state": "occupied", **{k: self.lease[k] for k in ("holderId", "holderLabel", "acquiredAt", "expiresAt")}}

    async def occupancy(self, hardware_id: str, action: str, holder_id=None, holder_label=None, lease_id=None) -> dict:
        self.check_id(hardware_id)
        async with self.lock:
            self.expire()
            same = self.lease and self.lease["holderId"] == holder_id and self.lease["leaseId"] == lease_id
            if action == "acquire":
                if self.draining:
                    raise OperationError("Service is draining", "service_unavailable")
                if not all(isinstance(x, str) and x for x in (holder_id, holder_label, lease_id)):
                    raise OperationError("acquire requires holderId, holderLabel and leaseId")
                if (self.lease and not same) or (self.busy and not same):
                    raise OperationError("FireDAP is occupied or completing a hardware job", "conflict")
                if not self.lease:
                    self.lease = {"holderId": holder_id, "holderLabel": holder_label,
                                  "leaseId": lease_id, "acquiredAt": now()}
                self.renew()
            elif action == "heartbeat":
                if same:
                    self.renew()
            elif action == "release":
                if same:
                    if self.busy:
                        raise OperationError("Wait for the running job before releasing FireDAP", "conflict")
                    self.lease = None
            elif action != "status":
                raise OperationError("Unknown occupancy action")
            return self.status()

    def renew(self) -> None:
        assert self.lease is not None
        self.lease["deadline"] = time.monotonic() + 15
        self.lease["expiresAt"] = datetime.fromtimestamp(time.time() + 15, timezone.utc).isoformat()

    async def discover(self) -> dict:
        # USB enumeration is isolated too; a disconnected HID backend cannot hang the MCP loop.
        async with self.lock:
            if self.busy:
                return {"probePresent": self.probe_present, "busy": True}
            result = await self.runner({"operation": "list_probes"}, 15)
            self.probe_present = any(p["serialNumber"] == self.config["probeSerial"] for p in result["probes"])
            return result

    def hardware(self) -> dict:
        state = "faulted" if self.last_error else "open" if self.probe_present else "unreachable"
        return {"hardwareId": self.config["hardwareId"], "computerId": self.config["computerId"],
                "serverId": self.config["serverId"], "state": state,
                "health": "job running" if self.busy else "CMSIS-DAP enumerated; target checked per operation" if self.probe_present else "Configured FireDAP is not connected",
                "lastError": self.last_error}

    async def start_job(self, hardware_id: str, lease_id: str | None, operation: str,
                        path: str | None = None, base_address: int | None = None,
                        expected_sha256: str | None = None, reset_after=True,
                        read_address: int | None = None, read_length: int | None = None) -> dict:
        self.check_id(hardware_id)
        async with self.lock:
            self.expire()
            if self.draining:
                raise OperationError("Service is draining", "service_unavailable")
            if self.busy:
                raise OperationError("A hardware job is already running", "conflict")
            if not self.lease or not lease_id or self.lease["leaseId"] != lease_id:
                raise OperationError("A current TestForge occupancy lease is required", "occupancy_required")
            request = {"operation": operation, "config": {k: self.config[k] for k in ("probeSerial", "packPath", "frequencyHz")},
                       "resetAfter": reset_after}
            summary = None
            if operation == "read_sram":
                validate_sram_read(read_address, read_length)
                request["readAddress"] = read_address
                request["readLength"] = read_length
            elif operation in {"flash", "verify"}:
                if not path or not expected_sha256:
                    raise OperationError("path and expected_sha256 from firedap_inspect_firmware are required")
                summary, segments = inspect_firmware(path, self.config["firmwareRoots"], base_address, expected_sha256)
                request["segments"] = encode_segments(segments)
            elif operation not in {"target_info", "reset"}:
                raise OperationError("Unknown hardware operation")
            job_id = str(uuid4())
            job = {"jobId": job_id, "operation": operation, "state": "running", "startedAt": now(), "firmware": summary}
            self.jobs[job_id] = job
            while len(self.jobs) > 100:
                self.jobs.pop(next(iter(self.jobs)))
            self.task = asyncio.create_task(self.finish_job(job, request))
            return dict(job)

    async def finish_job(self, job: dict, request: dict) -> None:
        try:
            job["result"] = await self.runner(request, self.config.get("operationTimeoutSeconds", 120))
            job["state"] = "succeeded"
            self.probe_present = True
            self.last_error = None
        except Exception as exc:
            job["state"] = "failed"
            job["error"] = error(exc)["error"]
            self.last_error = {"category": job["error"]["category"], "message": str(exc), "at": now()}
        finally:
            job["finishedAt"] = now()
            directory = Path(self.config["jobDirectory"])
            try:
                directory.mkdir(parents=True, exist_ok=True)
                dest = directory / f'{job["jobId"]}.json'
                temp = dest.with_suffix(".tmp")
                temp.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
                temp.replace(dest)
            except OSError as exc:
                job["auditError"] = str(exc)

    def get_job(self, job_id: str) -> dict:
        if job_id not in self.jobs:
            raise OperationError("Unknown job ID for this server session")
        return dict(self.jobs[job_id])

    async def shutdown(self) -> dict:
        async with self.lock:
            if self.busy:
                raise OperationError("Hardware job is running; safe shutdown refused until it finishes", "conflict")
            self.draining = True
            self.lease = None
            return {"safe": True, "draining": True}
