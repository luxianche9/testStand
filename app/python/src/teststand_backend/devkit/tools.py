"""Public tools of the device plugin development kit (design doc 8.5)."""

from __future__ import annotations

import asyncio
import inspect
from pathlib import Path
from typing import Any

from teststand_backend.contracts.errors import AppError
from teststand_backend.contracts.operations import Tool
from teststand_backend.contracts.validation import enum, obj, string
from teststand_backend.workspace.references import ReferenceService

from . import documents, kit

Json = dict[str, Any]
PROFILES = frozenset({"adapter"})
_PROTECTED: list[Path] = []


def configure(protected: list[Path]) -> None:
    """testStand's own folders, which no devkit tool reads from (set by the service at start)."""
    _PROTECTED[:] = protected


def protected_folders() -> list[Path]:
    return list(_PROTECTED)


def _project(app: Any, context: Json) -> Path:
    document = app.projects.document(context)
    if not document:
        raise AppError("requires_project", "Open a project first: adapters live in its plugins/")
    return Path(document["rootPath"])


def _object(properties: Json, required: list[str] | None = None) -> Json:
    return {"type": "object", "properties": properties, "required": required or []}


_RESULT = {"type": "object", "description": "Structured result; see ts-device-plugin."}
_ADAPTER = string(1, 40, regex="^[a-z][a-z0-9]*(_[a-z0-9]+)*$").describe(
    "Adapter id = device type, lowercase (e.g. rsx8, jcxd_sd48); folder plugins/<adapter>."
)


def _create(app: Any, context: Json, value: Json) -> Any:
    return kit.scaffold(
        _project(app, context),
        value["adapter"],
        value.get("prefix") or value["adapter"],
        value["model"],
        value["manufacturer"],
    )


async def _check(app: Any, context: Json, value: Json) -> Any:
    return await kit.check(_project(app, context), value["adapter"])


async def _package(app: Any, context: Json, value: Json) -> Any:
    result = await kit.pack(_project(app, context), value["adapter"])
    existing = [
        item["deviceId"]
        for item in app.devices.list_devices(context)
        if item.get("type") == value["adapter"]
    ]
    if existing:
        result["existingDevices"] = existing
        result["next"] = (
            "This device type is already on the bench: update its driver with "
            "devices_updatePackageFromFile(path) (adding it again would create another device "
            "for the same hardware); the operator confirms and restarts testStand."
        )
    return result


def _vendor_file(app: Any, context: Json, value: Json) -> Any:
    return kit.add_vendor_file(
        _project(app, context),
        value["adapter"],
        value["sourcePath"],
        value.get("target"),
        protected_folders(),
    )


def _list(app: Any, context: Json, value: Json) -> Any:
    project = _project(app, context)
    adapters = []
    for folder in sorted((project / kit.PLUGINS_DIR).glob("*/pyproject.toml")):
        adapter = folder.parent.name
        packages = sorted(
            p.relative_to(project).as_posix()
            for p in (project / kit.DIST_DIR).glob(f"{adapter}-*.tsdev")
        )
        adapters.append(
            {"adapter": adapter, "path": f"{kit.PLUGINS_DIR}/{adapter}", "packages": packages}
        )
    return {"adapters": adapters, "plugins": kit.PLUGINS_DIR, "dist": kit.DIST_DIR}


async def _import_document(app: Any, context: Json, value: Json) -> Any:
    project = _project(app, context)
    source = Path(value["sourcePath"])
    if not source.is_absolute():
        source = project / source
    if any(source.resolve().is_relative_to(root.resolve()) for root in protected_folders()):
        raise AppError("permission_denied", "testStand's own folders are not a document source")
    converted = await asyncio.to_thread(
        documents.convert, source, project, value.get("ocr", "auto")
    )
    references = ReferenceService(str(project))
    reference_id = value.get("referenceId") or converted["slug"]
    title = value.get("title") or source.name
    entry = {"referenceId": reference_id, "title": title, "path": converted["path"]}
    if value.get("hardwareId"):
        app.devices.get_hardware(context, value["hardwareId"])
        entry["hardwareId"] = value["hardwareId"]
    existing = next((r for r in references.index() if r["referenceId"] == reference_id), None)
    if existing is not None:
        entry["expectedHash"] = existing["sha256"]
    registered = references.register(entry)
    return {
        **converted,
        "referenceId": reference_id,
        "title": title,
        "sha256": registered.get("sha256"),
        "read": f"read_reference referenceId={reference_id} (query= to search), or read the "
        f"file {converted['path']} directly",
    }


_SDK_DOC_LIMIT = 6000


def _summary(obj: Any) -> str:
    doc = inspect.getdoc(obj) or ""
    return doc.strip().splitlines()[0] if doc.strip() else ""


def _signature(name: str, obj: Any) -> str:
    try:
        return f"{name}{inspect.signature(obj)}"
    except (TypeError, ValueError):
        return name


def describe_sdk(name: str | None) -> Json:
    """The SDK's public API from the installed package: names, signatures, docstrings."""
    import teststand_device_sdk as sdk
    import teststand_device_sdk.testing as testing

    roots: dict[str, Any] = {"testing": testing}
    if not name:
        items = []
        for public in sorted(getattr(sdk, "__all__", [])):
            obj = getattr(sdk, public, None)
            kind = "class" if inspect.isclass(obj) else "function" if callable(obj) else "value"
            items.append({"name": public, "kind": kind, "summary": _summary(obj)[:160]})
        items.append({"name": "testing", "kind": "module", "summary": _summary(testing)[:160]})
        return {
            "version": sdk.__version__,
            "items": items,
            "usage": "Import from the package root: from teststand_device_sdk import Device, ... "
            "(testing helpers: from teststand_device_sdk.testing import serve, check_device). "
            "Pass a name such as Device, Device.select_driver or testing.serve for details.",
        }
    head, _, rest = name.removeprefix("teststand_device_sdk.").partition(".")
    obj = roots.get(head, getattr(sdk, head, None))
    if obj is None or (head not in roots and head not in getattr(sdk, "__all__", [])):
        raise AppError("not_found", f"{name} is not a public name of teststand_device_sdk")
    for part in rest.split(".") if rest else []:
        obj = getattr(obj, part, None)
        if obj is None or part.startswith("_"):
            raise AppError("not_found", f"{name} is not a public member of the SDK")
    result: Json = {
        "name": name,
        "signature": _signature(name.rsplit(".", 1)[-1], obj) if callable(obj) else None,
        "doc": (inspect.getdoc(obj) or "")[:_SDK_DOC_LIMIT],
    }
    if inspect.isclass(obj) or inspect.ismodule(obj):
        members = []
        for member, value in inspect.getmembers(obj):
            if member.startswith("_") and member != "__init__":
                continue
            if inspect.ismodule(obj) and getattr(value, "__module__", "") != obj.__name__:
                continue
            if callable(value) or isinstance(value, property):
                target = value.fget if isinstance(value, property) else value
                members.append(
                    {
                        "name": member,
                        "signature": _signature(member, target),
                        "summary": _summary(target)[:200],
                    }
                )
            elif not inspect.ismodule(obj):
                members.append({"name": member, "value": repr(value)[:120]})
        result["members"] = members
    elif not callable(obj):
        result["value"] = repr(obj)[:400]
    return result


def _describe_sdk(app: Any, context: Json, value: Json) -> Any:
    return describe_sdk(value.get("name"))


DEVKIT_TOOLS = [
    Tool(
        "devkit_create_adapter",
        "Create a device plugin adapter in the project (plugins/<adapter>/) from the bundled "
        "template: a digital I/O skeleton with driver, simulator, pinout and tests that already "
        "passes the compliance suite. Read the ts-device-plugin reference first.",
        obj(
            {
                "adapter": _ADAPTER,
                "prefix": string(1, 40, regex="^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
                .optional()
                .describe("Tool name prefix (default: the adapter id), e.g. rsx8 -> rsx8_write."),
                "model": string(1, 80).describe("Model exactly as the manufacturer prints it."),
                "manufacturer": string(1, 80).describe("Manufacturer name."),
            },
            strict=True,
        ),
        _RESULT,
        call=_create,
        capability="devices.develop",
        profiles=PROFILES,
    ),
    Tool(
        "devkit_describe_sdk",
        "The device plugin SDK's API from the installed testStand: without name, every public "
        "name with a one-line summary; with a name (Device, param, ByteStream, "
        "single_connector_pinout, Device.select_driver, testing.serve ...), its signature, "
        "docstring and members. Use it instead of guessing a signature.",
        obj(
            {
                "name": string(1, 120)
                .optional()
                .describe("Public SDK name, optionally dotted (Class.member, testing.name)."),
            },
            strict=True,
        ),
        _RESULT,
        call=_describe_sdk,
        capability="devices.develop",
        read_only=True,
        profiles=PROFILES,
    ),
    Tool(
        "devkit_check_adapter",
        "Check an adapter on its simulator in a separate process: packaging rules, its tests "
        "(tests/test_*.py, pytest), the SDK compliance suite and leftover TODO(new_device) "
        "markers. Returns ok, problems, failing tests with tracebacks, the declared tools and "
        "streams, and the log. Never touches hardware.",
        obj({"adapter": _ADAPTER}, strict=True),
        _RESULT,
        call=_check,
        capability="devices.develop",
        read_only=True,
        profiles=PROFILES,
    ),
    Tool(
        "devkit_package_adapter",
        "Check, then build the adapter's device package dist/<type>-<version>.tsdev (only when "
        "the check passes). Add it to the bench with devices_addDeviceFromFile.",
        obj({"adapter": _ADAPTER}, strict=True),
        _RESULT,
        call=_package,
        capability="devices.develop",
        profiles=PROFILES,
    ),
    Tool(
        "devkit_add_vendor_file",
        "Copy a vendor runtime file (driver DLL, bridge .exe, firmware/config file) into the "
        "adapter package (default bin/<name>) and list it under requiredFiles, so the package "
        "carries it. Source files (.py) are written directly instead.",
        obj(
            {
                "adapter": _ADAPTER,
                "sourcePath": string(1, 1000).describe(
                    "Absolute path of the vendor file (e.g. the x64 DLL from the manual's CD)."
                ),
                "target": string(1, 200)
                .optional()
                .describe("Path inside the package, default bin/<file name>."),
            },
            strict=True,
        ),
        _RESULT,
        call=_vendor_file,
        capability="devices.develop",
        profiles=PROFILES,
    ),
    Tool(
        "devkit_list_adapters",
        "List the adapters in this project (plugins/) and their built packages (dist/).",
        obj({}, strict=True),
        _RESULT,
        call=_list,
        capability="devices.develop",
        read_only=True,
        profiles=PROFILES,
    ),
    Tool(
        "import_document",
        "Convert a manual or data sheet (PDF, DOCX, XLSX, an image, or text/source such as "
        ".h/.cpp/.txt in UTF-8 or GBK) to text in the project's docs/ folder and register it as "
        "a reference. Use it for every PDF/Word/Excel document and picture: their binary form "
        "cannot be read directly. Figures (pin tables drawn as pictures) and scanned pages are "
        "read by offline OCR and marked as such; verify OCR text. Then search it with "
        "read_reference(referenceId, query).",
        obj(
            {
                "sourcePath": string(1, 1000).describe(
                    "Absolute path of the document, or a path relative to the project."
                ),
                "referenceId": string(1, 80, regex="^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")
                .optional()
                .describe("Reference ID; default derived from the file name."),
                "title": string(1, 200).optional().describe("Title; default the file name."),
                "ocr": enum(*documents.OCR_MODES)
                .default("auto")
                .describe(
                    "Read pictures with the offline OCR: auto (pages that are mostly picture, "
                    "e.g. connector figures, and scans), all pages, or none."
                ),
                "hardwareId": string(1)
                .optional()
                .describe("Registered hardware this document describes."),
            },
            strict=True,
        ),
        _RESULT,
        call=_import_document,
        capability="references.manage",
        profiles=frozenset({"adapter", "plan", "explore"}),
    ),
]
