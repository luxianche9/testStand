import asyncio
import os
from os import stat
from pathlib import Path

from teststand_backend.contracts.errors import app_error
from teststand_backend.contracts.projects import parse_project_file
from teststand_backend.contracts.wiring import parse_project_wiring
from teststand_backend.storage import SettingsStore, atomic_json, read_json
from teststand_backend.util import UNDEFINED, Record, clone, new_uuid, utc_now_iso


class ProjectService:
    def __init__(self, settings: SettingsStore) -> None:
        self._settings = settings
        self._root_path: str | None = None
        self._path: str | None = None
        self._file: Record | None = None
        self._dirty = False
        self._write_lock = asyncio.Lock()

    async def initialize(self) -> None:
        self._clear_current()

    def current(self) -> Record | None:
        if not self._root_path or not self._path or self._file is None:
            return None
        return {
            "rootPath": self._root_path,
            "path": self._path,
            "dirty": self._dirty,
            "file": clone(self._file),
        }

    def document(self) -> Record:
        return self._require_document()

    def session(self) -> Record | None:
        if self._file is None or not self._root_path:
            return None
        return {"projectId": self._file["projectId"], "rootPath": self._root_path}

    def project_id(self) -> str:
        return str(self._require_file()["projectId"])

    def wiring(self) -> Record:
        result: Record = clone(self._require_file()["wiring"])
        return result

    async def inspect_folder(self, root_path: str | Path) -> Record:
        root = await _canonical_directory(root_path)
        name = os.path.basename(root) or root
        try:
            raw = await read_json(project_path(root))
            if raw is UNDEFINED:
                return {"rootPath": root, "state": "uninitialized", "name": name}
            file = parse_project_file(raw)
            return {"rootPath": root, "state": "ready", "name": file["name"]}
        except Exception as error:
            return {"rootPath": root, "state": "invalid", "name": name, "message": str(error)}

    async def initialize_folder(self, root_path: str | Path) -> Record:
        selection = await self.inspect_folder(root_path)
        if selection["state"] == "ready":
            raise app_error("project_exists", "project_exists")
        if selection["state"] == "invalid":
            raise app_error("invalid_project", selection.get("message", "invalid_project"))
        file = empty_project_file(selection["name"])
        path = project_path(selection["rootPath"])
        await atomic_json(path, file)
        self._root_path = selection["rootPath"]
        self._path = path
        self._file = file
        self._dirty = False
        await self._remember_current()
        return self._require_document()

    async def open_folder(self, root_path: str | Path) -> Record:
        selection = await self.inspect_folder(root_path)
        if selection["state"] == "uninitialized":
            raise app_error("project_uninitialized", "project_uninitialized")
        if selection["state"] == "invalid":
            raise app_error("invalid_project", selection.get("message", "invalid_project"))
        path = project_path(selection["rootPath"])
        file = parse_project_file(await read_json(path))
        self._root_path = selection["rootPath"]
        self._path = path
        self._file = file
        self._dirty = False
        await self._remember_current()
        return self._require_document()

    async def save(self) -> Record:
        async with self._write_lock:
            return await self._save()

    async def _save(self) -> Record:
        path = self._require_document()["path"]
        next_value = parse_project_file({**self._require_file(), "updatedAt": utc_now_iso()})
        await atomic_json(path, next_value)
        self._file = next_value
        self._dirty = False
        await self._remember_current()
        return self._require_document()

    async def leave(self) -> None:
        self._clear_current()

    async def list_recent(self) -> list[Record]:
        async def inspect(item: Record) -> Record:
            root = os.path.abspath(item["rootPath"])
            fallback = {
                "rootPath": root,
                "name": item["name"],
                "openedAt": item["openedAt"],
                "preview": {"nodes": [], "connections": []},
            }
            try:
                await asyncio.to_thread(stat, root)
                if not os.path.isdir(root):
                    return {**fallback, "status": "missing", "message": "project_folder_missing"}
            except OSError as error:
                return {**fallback, "status": "missing", "message": str(error)}
            try:
                raw = await read_json(project_path(root))
                if raw is UNDEFINED:
                    return {**fallback, "status": "invalid", "message": "project_manifest_missing"}
                file = parse_project_file(raw)
                return {
                    "rootPath": root,
                    "name": file["name"],
                    "openedAt": item["openedAt"],
                    "updatedAt": file["updatedAt"],
                    "status": "available",
                    "preview": {
                        "nodes": clone(file["wiring"]["nodes"]),
                        "connections": [
                            {key: connection[key] for key in ("connectionId", "portA", "portB")}
                            for connection in file["wiring"]["connections"]
                        ],
                    },
                }
            except Exception as error:
                return {**fallback, "status": "invalid", "message": str(error)}

        return list(
            await asyncio.gather(
                *(inspect(item) for item in self._settings.get()["recentProjects"])
            )
        )

    async def forget_recent(self, root_path: str | Path) -> None:
        key = _normalized_path(root_path)
        await self._settings.update(
            {
                "recentProjects": [
                    item
                    for item in self._settings.get()["recentProjects"]
                    if _normalized_path(item["rootPath"]) != key
                ]
            }
        )

    def update_wiring(self, wiring: Record) -> Record:
        file = self._require_file()
        self._file = {**file, "wiring": parse_project_wiring(wiring), "updatedAt": utc_now_iso()}
        self._dirty = True
        return self._require_document()

    async def update_wiring_with_layout(self, wiring: Record) -> Record:
        """Save changed geometry on existing disk nodes without committing structural edits."""
        async with self._write_lock:
            current = self._require_document()
            next_wiring = parse_project_wiring(wiring)
            previous = {node["hardwareId"]: node for node in current["file"]["wiring"]["nodes"]}
            layout_keys = ("x", "y", "width", "height", "portPositions")
            changes = {
                node["hardwareId"]: {
                    key: node[key]
                    for key in layout_keys
                    if key in node and node.get(key) != previous[node["hardwareId"]].get(key)
                }
                for node in next_wiring["nodes"]
                if node["hardwareId"] in previous
            }
            changes = {identifier: patch for identifier, patch in changes.items() if patch}
            if not changes:
                return self.update_wiring(next_wiring)
            saved = parse_project_file(await read_json(current["path"]))
            if saved["projectId"] != current["file"]["projectId"]:
                raise app_error("conflict", "Project changed on disk; reopen it before editing.")
            saved_nodes = [
                {**node, **changes.get(node["hardwareId"], {})} for node in saved["wiring"]["nodes"]
            ]
            if saved_nodes != saved["wiring"]["nodes"]:
                saved = parse_project_file(
                    {
                        **saved,
                        "wiring": {**saved["wiring"], "nodes": saved_nodes},
                        "updatedAt": utc_now_iso(),
                    }
                )
                await atomic_json(current["path"], saved)
            # A project switch during disk I/O must not update the newly opened project.
            if self.current() != current:
                raise app_error(
                    "conflict", "Project changed while saving its layout; retry the edit."
                )
            self.update_wiring(next_wiring)
            self._dirty = next_wiring != saved["wiring"]
            return self._require_document()

    async def close(self) -> None:
        """Structural edits are written only by explicit save."""

    def _require_file(self) -> Record:
        if self._file is None:
            raise app_error("requires_project", "requires_project")
        return self._file

    def _require_document(self) -> Record:
        file = self._require_file()
        if not self._root_path or not self._path:
            raise app_error("requires_project", "requires_project")
        return {
            "rootPath": self._root_path,
            "path": self._path,
            "dirty": self._dirty,
            "file": clone(file),
        }

    def _clear_current(self) -> None:
        self._root_path = None
        self._path = None
        self._file = None
        self._dirty = False

    async def _remember_current(self) -> None:
        current = self._require_document()
        key = _normalized_path(current["rootPath"])
        next_value = [
            {
                "rootPath": current["rootPath"],
                "name": current["file"]["name"],
                "openedAt": utc_now_iso(),
            },
            *[
                item
                for item in self._settings.get()["recentProjects"]
                if _normalized_path(item["rootPath"]) != key
            ],
        ]
        await self._settings.update({"recentProjects": next_value})


def empty_project_file(name: str = "Untitled project") -> Record:
    now = utc_now_iso()
    return parse_project_file(
        {
            "formatVersion": 4,
            "projectId": new_uuid(),
            "name": name,
            "wiring": {"nodes": [], "connections": []},
            "createdAt": now,
            "updatedAt": now,
        }
    )


def project_path(root_path: str | Path) -> str:
    return os.path.join(os.path.abspath(root_path), ".teststand", "project.json")


def project_display_name(document: Record) -> str:
    return str(document["file"]["name"] or os.path.basename(document["rootPath"]))


async def _canonical_directory(root_path: str | Path) -> str:
    target = os.path.abspath(root_path)
    await asyncio.to_thread(stat, target)
    if not os.path.isdir(target):
        raise app_error("invalid_project_folder", "invalid_project_folder")
    try:
        return await asyncio.to_thread(os.path.realpath, target, strict=True)
    except OSError:
        return target


def _normalized_path(value: str | Path) -> str:
    target = os.path.abspath(value).rstrip("\\/")
    return target.lower() if os.name == "nt" else target
