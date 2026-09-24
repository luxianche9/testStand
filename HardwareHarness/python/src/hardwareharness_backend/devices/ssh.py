from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import time
from typing import Any

import paramiko

from hardwareharness_backend.util import json_dumps

Record = dict[str, Any]
SshCredential = Record
SshResult = Record


def fingerprint(key: bytes) -> str:
    return "SHA256:" + base64.b64encode(hashlib.sha256(key).digest()).decode().rstrip("=")


class _HostKeyPolicy(paramiko.MissingHostKeyPolicy):
    def __init__(self, expected: str | None) -> None:
        self.expected = expected

    def missing_host_key(
        self, client: paramiko.SSHClient, hostname: str, key: paramiko.PKey
    ) -> None:
        if self.expected and fingerprint(key.asbytes()) != self.expected:
            raise paramiko.SSHException("Host denied (verification failed)")


class SshManager:
    def __init__(self, secrets: Any) -> None:
        self.secrets = secrets
        self.clients: dict[str, tuple[str, paramiko.SSHClient]] = {}
        self._connecting: dict[str, tuple[str, asyncio.Task[paramiko.SSHClient]]] = {}
        self._generations: dict[str, int] = {}
        self._closed = False

    def _connection_key(self, computer: Record) -> str:
        value = {
            "address": computer["address"],
            "port": computer["ssh"]["port"],
            "username": computer["ssh"]["username"],
            "secretKey": f"ssh:{computer['id']}",
            **(
                {"hostKeyFingerprint": computer["ssh"]["hostKeyFingerprint"]}
                if "hostKeyFingerprint" in computer["ssh"]
                else {}
            ),
            "credential": self.secrets.get(f"ssh:{computer['id']}"),
        }
        return hashlib.sha256(json_dumps(value).encode()).hexdigest()

    def _open(self, computer: Record) -> paramiko.SSHClient:
        credential = self.secrets.get(f"ssh:{computer['id']}")
        config: Record = {
            "hostname": computer["address"],
            "port": computer["ssh"]["port"],
            "username": computer["ssh"]["username"],
            "timeout": 10,
            "banner_timeout": 10,
            "auth_timeout": 10,
            "look_for_keys": False,
            "allow_agent": False,
        }
        if credential.get("kind") == "password" and credential.get("password"):
            config["password"] = credential["password"]
        if credential.get("kind") == "privateKey" and credential.get("privateKey"):
            config["pkey"] = _private_key(credential["privateKey"], credential.get("passphrase"))
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(
            _HostKeyPolicy(computer["ssh"].get("hostKeyFingerprint"))
        )
        try:
            client.connect(**config)
            transport = client.get_transport()
            if transport:
                transport.set_keepalive(5)
            return client
        except BaseException:
            client.close()
            raise

    async def _connect(self, computer: Record) -> paramiko.SSHClient:
        if self._closed:
            raise RuntimeError("SSH manager is closed")
        identifier = computer["id"]
        key = self._connection_key(computer)
        existing = self.clients.get(identifier)
        if existing:
            transport = existing[1].get_transport()
            if existing[0] == key and transport and transport.is_active():
                return existing[1]
            await self.disconnect(identifier)
        pending = self._connecting.get(identifier)
        if pending:
            if pending[0] == key:
                return await asyncio.shield(pending[1])
            await asyncio.gather(pending[1], return_exceptions=True)
            await self.disconnect(identifier)
        generation = self._generations.get(identifier, 0)

        async def create() -> paramiko.SSHClient:
            client = await asyncio.to_thread(self._open, computer)
            if self._closed or self._generations.get(identifier, 0) != generation:
                client.close()
                raise RuntimeError("SSH connection was superseded")
            self.clients[identifier] = (key, client)
            return client

        task = asyncio.create_task(create())
        self._connecting[identifier] = (key, task)
        try:
            return await asyncio.shield(task)
        finally:
            if self._connecting.get(identifier, (None, None))[1] is task:
                self._connecting.pop(identifier, None)

    async def disconnect(self, computer_id: str) -> None:
        self._generations[computer_id] = self._generations.get(computer_id, 0) + 1
        entry = self.clients.pop(computer_id, None)
        if entry:
            entry[1].close()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await asyncio.gather(
            *(
                self.disconnect(identifier)
                for identifier in set(self.clients) | set(self._connecting)
            ),
            return_exceptions=True,
        )

    async def execute(
        self, computer: Record, command: str, timeout_ms: int = 60000, max_bytes: int = 64 * 1024
    ) -> Record:
        client = await self._connect(computer)
        try:
            return await asyncio.to_thread(_execute, client, command, timeout_ms, max_bytes)
        except TimeoutError as error:
            await self.disconnect(computer["id"])
            raise RuntimeError(f"SSH command timed out after {timeout_ms} ms") from error


def _private_key(value: str, passphrase: str | None) -> paramiko.PKey:
    failure: Exception | None = None
    kinds: list[type[paramiko.PKey]] = [paramiko.RSAKey, paramiko.ECDSAKey, paramiko.Ed25519Key]
    for kind in kinds:
        try:
            return kind.from_private_key(io.StringIO(value), password=passphrase)
        except (paramiko.SSHException, ValueError) as error:
            failure = error
    raise paramiko.SSHException("Cannot parse privateKey") from failure


def _append_output(previous: str, data: bytes, maximum: int) -> tuple[str, bool]:
    value = previous + data.decode("utf-8", errors="replace")
    encoded = value.encode("utf-8")
    if len(encoded) <= maximum:
        return value, False
    # Approved TS bug exception: byte limits must not use UTF-16 character slicing.
    return encoded[:maximum].decode("utf-8", errors="ignore"), True


def _execute(client: paramiko.SSHClient, command: str, timeout_ms: int, max_bytes: int) -> Record:
    started = time.monotonic()
    stdin, stdout, _stderr = client.exec_command(command, timeout=timeout_ms / 1000)
    stdin.close()
    channel = stdout.channel
    out = err = ""
    truncated = False
    while True:
        if channel.recv_ready():
            out, was_truncated = _append_output(out, channel.recv(65536), max_bytes)
            truncated = truncated or was_truncated
        if channel.recv_stderr_ready():
            err, was_truncated = _append_output(err, channel.recv_stderr(65536), max_bytes)
            truncated = truncated or was_truncated
        if (
            channel.exit_status_ready()
            and not channel.recv_ready()
            and not channel.recv_stderr_ready()
        ):
            break
        if (time.monotonic() - started) * 1000 >= timeout_ms:
            channel.close()
            raise TimeoutError()
        time.sleep(0.01)
    code = channel.recv_exit_status()
    return {
        "exitCode": None if code == -1 else code,
        "stdout": out,
        "stderr": err,
        "truncated": truncated,
        "durationMs": int((time.monotonic() - started) * 1000),
    }
