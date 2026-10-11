"""Device packages (.tsdev): inspect, install, upgrade and uninstall across restarts."""

from __future__ import annotations

import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from teststand_device_sdk import PLUGINS_ENV, load_device

from teststand_backend.contracts.errors import AppError
from teststand_backend.devices.plugin_store import PluginStore
from teststand_backend.devices.plugin_transport import installed_device_types

MODULE = """from teststand_device_sdk import Device


class Fake(Device):
    manufacturer = "Acme"
    model = "FAKE-{version}"
    prefix = "fake"
    description = "Packaged test device."


DEVICE = Fake
"""


def wheel(
    dist: str = "teststand_adapter_fake",
    version: str = "1.0.0",
    device_type: str = "fake",
    requires: tuple[str, ...] = ("teststand-device-sdk>=0.2,<0.3",),
    extra: dict[str, bytes] | None = None,
    tag: str = "py3-none-any",
) -> tuple[str, bytes]:
    name = f"{dist}-{version}-{tag}.whl"
    info = f"{dist}-{version}.dist-info"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        if device_type:
            archive.writestr(f"{dist}/__init__.py", MODULE.format(version=version))
        metadata = [
            "Metadata-Version: 2.1",
            f"Name: {dist.replace('_', '-')}",
            f"Version: {version}",
        ]
        metadata += [f"Requires-Dist: {item}" for item in requires]
        archive.writestr(f"{info}/METADATA", "\n".join(metadata) + "\n")
        archive.writestr(f"{info}/WHEEL", "Wheel-Version: 1.0\nRoot-Is-Purelib: true\n")
        if device_type:
            archive.writestr(
                f"{info}/entry_points.txt", f"[teststand.devices]\n{device_type} = {dist}:DEVICE\n"
            )
        for path, content in (extra or {}).items():
            archive.writestr(path, content)
    return name, buffer.getvalue()


def package(
    wheels: list[tuple[str, bytes]] | None = None,
    entries: dict[str, bytes] | None = None,
    **manifest: Any,
) -> bytes:
    wheels = wheels or [wheel(version=manifest.get("version", "1.0.0"))]
    document = {
        "formatVersion": 1,
        "kind": "devicePlugin",
        "type": "fake",
        "distribution": "teststand-adapter-fake",
        "version": "1.0.0",
        "manufacturer": "Acme",
        "model": "FAKE-1",
        "isolation": "inproc",
        "sdk": ">=0.2,<0.3",
        "vendorDrivers": ["Acme driver"],
        "files": {name: hashlib.sha256(content).hexdigest() for name, content in wheels},
        **manifest,
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("package.json", json.dumps(document))
        for name, content in wheels:
            archive.writestr(f"wheels/{name}", content)
        for path, content in (entries or {}).items():
            archive.writestr(path, content)
    return buffer.getvalue()


@pytest.fixture
def isolated(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setenv(PLUGINS_ENV, "")
    yield
    for name in [name for name in sys.modules if name.startswith("teststand_adapter_fake")]:
        del sys.modules[name]


async def store(tmp_path: Path) -> PluginStore:
    plugins = PluginStore(tmp_path / "plugins")
    await plugins.initialize()
    return plugins


async def test_install_makes_a_new_type_available_at_once(tmp_path: Path, isolated: Any) -> None:
    plugins = await store(tmp_path)
    data = package()
    report = plugins.inspect(data)
    assert report["problems"] == [] and report["action"] == "install"
    assert report["manifest"]["vendorDrivers"] == ["Acme driver"]
    assert report["files"][0]["sha256"] == hashlib.sha256(package_wheel(data)).hexdigest()
    assert not (tmp_path / "plugins" / "fake").exists()  # inspecting writes nothing
    result = await plugins.install(data)
    assert result == {
        "type": "fake",
        "version": "1.0.0",
        "action": "install",
        "restartRequired": False,
    }
    assert load_device("fake").model == "FAKE-1.0.0"
    listed = next(item for item in installed_device_types() if item["type"] == "fake")
    assert listed["source"] == "package" and listed["version"] == "1.0.0"
    [installed] = plugins.list_packages()
    assert installed["active"] and "pending" not in installed and installed["model"] == "FAKE-1"


async def test_upgrade_and_uninstall_wait_for_the_next_start(tmp_path: Path, isolated: Any) -> None:
    plugins = await store(tmp_path)
    await plugins.install(package())
    upgrade = package(wheels=[wheel(version="1.1.0")], version="1.1.0")
    assert plugins.inspect(upgrade)["action"] == "upgrade"
    assert (await plugins.install(upgrade))["restartRequired"] is True
    [entry] = plugins.list_packages()
    assert entry["version"] == "1.0.0" and entry["pending"] == {
        "action": "install",
        "version": "1.1.0",
    }
    assert len(list((tmp_path / "plugins" / "fake").iterdir())) == 2

    restarted = await store(tmp_path)
    [entry] = restarted.list_packages()
    assert entry["version"] == "1.1.0" and "pending" not in entry
    assert len(list((tmp_path / "plugins" / "fake").iterdir())) == 1  # old version pruned

    assert (await restarted.uninstall("fake"))["restartRequired"] is True
    assert restarted.list_packages()[0]["pending"] == {"action": "uninstall"}
    after = await store(tmp_path)
    assert after.list_packages() == [] and not (tmp_path / "plugins" / "fake").exists()
    with pytest.raises(AppError, match="not installed"):
        await after.uninstall("fake")


def package_wheel(data: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return archive.read(next(n for n in archive.namelist() if n.endswith(".whl")))


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"not a zip", "ZIP"),
        (package(entries={"evil.py": b""}), "Unexpected entry"),
        (package(entries={"../escape": b""}), "Unsafe path"),
        (package(files={"other.whl": "0" * 64}), "do not match"),
        (package(kind="hardware"), "Invalid package.json"),
    ],
)
async def test_malformed_packages_are_rejected(
    tmp_path: Path, isolated: Any, data: bytes, message: str
) -> None:
    plugins = await store(tmp_path)
    with pytest.raises(AppError, match=message):
        plugins.inspect(data)


def test_tampered_wheel_fails_its_hash() -> None:
    name, content = wheel()
    data = package(wheels=[(name, content)], files={name: hashlib.sha256(b"x").hexdigest()})
    with pytest.raises(AppError, match="SHA-256 mismatch"):
        PluginStore("unused").inspect(data)


@pytest.mark.parametrize(
    ("data", "problem"),
    [
        (package(sdk=">=9"), "needs device SDK"),
        (package(wheels=[wheel(requires=("teststand-device-sdk>=9",))]), "Adapter needs"),
        (package(wheels=[wheel(requires=("teststand-device-sdk", "numpy"))]), "numpy is not in"),
        (
            package(wheels=[wheel(requires=("teststand-device-sdk", "pydantic<2"))]),
            "ships pydantic",
        ),
        (package(wheels=[wheel(tag="cp312-cp312-linux_x86_64")]), "not built for CPython 3.11"),
        (package(type="other"), "says other"),
        (package(wheels=[wheel(device_type="")]), "No wheel declares"),
        (
            package(wheels=[wheel(extra={"teststand_adapter_fake-1.0.0.data/scripts/x": b""})]),
            None,
        ),
    ],
)
async def test_packages_that_do_not_fit_this_testStand_are_refused(
    tmp_path: Path, isolated: Any, data: bytes, problem: str | None
) -> None:
    plugins = await store(tmp_path)
    if problem is None:
        with pytest.raises(AppError, match="outside the package"):
            await plugins.install(data)
        assert not (tmp_path / "plugins" / "fake").exists()
        return
    assert any(problem in item for item in plugins.inspect(data)["problems"])
    with pytest.raises(AppError, match="cannot be installed"):
        await plugins.install(data)


async def test_wheel_data_purelib_is_unpacked_into_the_site(tmp_path: Path, isolated: Any) -> None:
    extra = {"teststand_adapter_fake-1.0.0.data/purelib/fake_extra.py": b"VALUE = 7\n"}
    plugins = await store(tmp_path)
    await plugins.install(package(wheels=[wheel(extra=extra)]))
    [site] = (tmp_path / "plugins" / "fake").glob("*/site")
    assert (site / "fake_extra.py").read_text() == "VALUE = 7\n"


async def test_adding_a_device_installs_its_package_and_removing_it_uninstalls(
    tmp_path: Path, isolated: Any
) -> None:
    from teststand_backend.application import DefaultAuthorizer, DevicesApplication
    from teststand_backend.application.authorization import (
        AGENT_REQUEST_CONTEXT as AGENT,
    )
    from teststand_backend.application.authorization import (
        HUMAN_REQUEST_CONTEXT as HUMAN,
    )
    from teststand_backend.contracts.operations import operation_spec
    from teststand_backend.devices import DeviceService, DeviceStore, PluginTransport

    packages = await store_for(tmp_path)
    devices = DeviceStore(tmp_path / "devices")
    await devices.initialize()
    service = DeviceService(devices, PluginTransport(), packages)
    app = DevicesApplication(DefaultAuthorizer(), service, None)  # type: ignore[arg-type]
    data = package()
    assert app.inspect_package(HUMAN, data)["action"] == "install"
    first = await app.add_device(HUMAN, data, "继电器卡")
    assert first["device"]["deviceId"] == "FAKE" and first["device"]["label"] == "继电器卡"
    assert first["device"]["hardwareId"] == "FAKE_CARD" and first["restartRequired"] is False
    # The same package again: nothing to install, a second device of that model.
    assert app.inspect_package(HUMAN, data)["action"] == "present"
    second = await app.add_device(HUMAN, data)
    assert (second["device"]["deviceId"], second["device"]["label"]) == ("FAKE_2", "FAKE-1")
    await app.remove_device(HUMAN, "FAKE")
    assert packages.installed("fake")  # still used by FAKE_2
    await app.remove_device(HUMAN, "FAKE_2")
    assert not packages.installed("fake")
    assert (await store_for(tmp_path)).list_packages() == []
    # The package runs code in the backend: when an agent adds one, the operator confirms first.
    for method in (app.add_device, app.add_device_from_file, app.remove_device, app.save_device):
        spec = operation_spec(method)
        assert spec is not None and spec.confirm
        assert DefaultAuthorizer().is_allowed(AGENT, spec.capability)
    file = tmp_path / "fake.tsdev"
    file.write_bytes(data)
    third = await app.add_device_from_file(HUMAN, str(file), "从文件")
    assert third["device"]["label"] == "从文件"
    with pytest.raises(AppError, match="absolute path"):
        await app.add_device_from_file(HUMAN, "fake.tsdev")
    with pytest.raises(AppError, match="Cannot read"):
        await app.add_device_from_file(HUMAN, str(tmp_path / "missing.tsdev"))
    bare = DevicesApplication(
        DefaultAuthorizer(),
        SimpleNamespace(packages=None),  # type: ignore[arg-type]
        SimpleNamespace(),  # type: ignore[arg-type]
    )
    with pytest.raises(AppError, match="not available"):
        bare.inspect_package(HUMAN, data)


async def test_a_driver_the_environment_already_has_is_not_installed(
    tmp_path: Path, isolated: Any
) -> None:
    plugins = await store(tmp_path)
    data = package(type="pci1762", wheels=[wheel(device_type="pci1762")])
    report = plugins.inspect(data)
    assert report["problems"] == [] and report["action"] == "present"
    assert (await plugins.install(data))["action"] == "present"
    assert plugins.list_packages() == []


store_for = store


@pytest.mark.parametrize(
    ("data", "problem"),
    [
        (package(wheels=[wheel(), wheel("other_adapter", device_type="fake2")]), "More than one"),
        (package(distribution="someone-else"), "package.json says someone-else"),
        (package(sdk="not a range"), "Invalid SDK range"),
        (
            package(wheels=[wheel(requires=("teststand-device-sdk", "bad requirement!!"))]),
            "Invalid",
        ),
        (
            package(wheels=[wheel(), wheel("teststand_device_sdk", "0.2.0", "", ())]),
            "must not carry",
        ),
        (package(wheels=[wheel(requires=("pywin32; sys_platform == 'nothing'",))]), None),
    ],
)
async def test_more_package_checks(
    tmp_path: Path, isolated: Any, data: bytes, problem: str | None
) -> None:
    problems = (await store(tmp_path)).inspect(data)["problems"]
    if problem is None:
        assert problems == []  # a requirement whose marker does not apply is skipped
    else:
        assert any(problem in item for item in problems), problems


async def test_inspect_compares_with_a_pending_upgrade(tmp_path: Path, isolated: Any) -> None:
    plugins = await store(tmp_path)
    await plugins.install(package())
    upgrade = package(wheels=[wheel(version="1.1.0")], version="1.1.0")
    await plugins.install(upgrade)
    report = plugins.inspect(upgrade)
    assert report["action"] == "present" and report["installedVersion"] == "1.1.0"
    await plugins.uninstall("fake")
    assert plugins.inspect(upgrade)["action"] == "install"


async def test_type_listing_reports_duplicates_and_broken_packages(
    tmp_path: Path, isolated: Any
) -> None:
    plugins = await store(tmp_path)
    broken = wheel(dist="teststand_adapter_fake", device_type="fake")
    name, content = broken
    with zipfile.ZipFile(io.BytesIO(content)) as source:
        files = {item: source.read(item) for item in source.namelist()}
    files["teststand_adapter_fake/__init__.py"] = b"raise ImportError('vendor DLL missing')\n"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as target:
        for item, value in files.items():
            target.writestr(item, value)
    await plugins.install(package(wheels=[(name, buffer.getvalue())]))
    [listed] = [item for item in installed_device_types() if item["type"] == "fake"]
    assert listed["source"] == "package" and "vendor DLL missing" in listed["error"]

    second = tmp_path / "elsewhere"
    info = second / "twin-1.0.dist-info"
    info.mkdir(parents=True)
    (info / "METADATA").write_text("Metadata-Version: 2.1\nName: twin\nVersion: 1.0\n")
    (info / "entry_points.txt").write_text("[teststand.devices]\nfake = twin:DEVICE\n")
    sys.path.append(str(second))
    import importlib

    importlib.invalidate_caches()
    [listed] = [item for item in installed_device_types() if item["type"] == "fake"]
    assert "declared twice" in listed["error"]


async def test_dependencies_testStand_ships_are_left_out(tmp_path: Path, isolated: Any) -> None:
    adapter = wheel(requires=("teststand-device-sdk", "pydantic>=2", "extra-dep"))
    data = package(
        wheels=[adapter, wheel("pydantic", "2.0", "", ()), wheel("extra_dep", "1", "", ())]
    )
    plugins = await store(tmp_path)
    report = plugins.inspect(data)
    assert report["problems"] == []
    assert {item["name"].split("-")[0]: item["skipped"] for item in report["files"]} == {
        "pydantic": True,
        "extra_dep": False,
        "teststand_adapter_fake": False,
    }
    await plugins.install(data)
    [site] = (tmp_path / "plugins" / "fake").glob("*/site")
    assert (site / "extra_dep-1.dist-info").is_dir() and not (
        site / "pydantic-2.0.dist-info"
    ).exists()


async def test_updating_a_package_keeps_the_devices_and_waits_for_a_restart(
    tmp_path: Path, isolated: Any
) -> None:
    from teststand_backend.application import DefaultAuthorizer, DevicesApplication
    from teststand_backend.application.authorization import HUMAN_REQUEST_CONTEXT as HUMAN
    from teststand_backend.contracts.operations import operation_spec
    from teststand_backend.devices import DeviceService, DeviceStore, PluginTransport

    packages = await store_for(tmp_path)
    devices = DeviceStore(tmp_path / "devices")
    await devices.initialize()
    service = DeviceService(devices, PluginTransport(), packages)
    app = DevicesApplication(DefaultAuthorizer(), service, None)  # type: ignore[arg-type]
    old, new = tmp_path / "fake-1.tsdev", tmp_path / "fake-2.tsdev"
    old.write_bytes(package())
    new.write_bytes(package(version="2.0.0"))
    # Not installed yet: an update has nothing to update.
    with pytest.raises(AppError, match="not installed"):
        await app.update_package_from_file(HUMAN, str(new))
    await app.add_device_from_file(HUMAN, str(old))
    assert app.list_packages(HUMAN)["restartRequired"] is False
    updated = await app.update_package_from_file(HUMAN, str(new))
    assert updated == {
        "type": "fake",
        "version": "2.0.0",
        "action": "upgrade",
        "devices": ["FAKE"],
        "restartRequired": True,
    }
    assert [item["deviceId"] for item in service.list_devices()] == ["FAKE"]
    listing = app.list_packages(HUMAN)
    assert listing["restartRequired"] is True
    assert listing["packages"][0]["pending"] == {"action": "install", "version": "2.0.0"}
    spec = operation_spec(app.update_package_from_file)
    assert spec is not None and spec.confirm
    for path in ("fake.tsdev", str(tmp_path / "missing.tsdev")):
        with pytest.raises(AppError):
            await app.update_package_from_file(HUMAN, path)
