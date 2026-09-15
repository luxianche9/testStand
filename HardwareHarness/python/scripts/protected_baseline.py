"""Verify the explicitly frozen behavior boundary for the presentation/deletion stage.

The original all-renderer baseline and its approved exception remain historical evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def snapshot(root: Path) -> dict[str, str]:
    """Hash protected source and pin the unchanged integration dependencies."""
    files = list((root / "python/src").rglob("*.py"))
    files += [
        path
        for path in (root / "apps/desktop/src/renderer").rglob("*.ts")
        if not path.name.endswith((".test.ts", ".spec.ts"))
    ]
    files += list((root / "apps/desktop/src/main").glob("opencode-*.ts"))
    files += [path for path in (root / "patches").glob("*") if "opencode" in path.name.lower()]
    result = {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(files)
        if path.is_file()
    }
    package = json.loads((root / "apps/desktop/package.json").read_text(encoding="utf-8"))
    for group in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        for name, version in package.get(group, {}).items():
            if name == "@assistant-ui/react-opencode" or "opencode" in name.lower():
                result[f"dependency:{group}:{name}"] = version
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("capture", "check"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    target = root / "python/reports/stage-protected-files.json"
    actual = snapshot(root)
    if args.action == "capture":
        if target.exists():
            raise SystemExit("Protected baseline already exists; refusing to replace it")
        target.parent.mkdir(parents=True, exist_ok=True)
        raise SystemExit(
            "Stage capture requires an explicitly reviewed new baseline and provenance"
        )
    else:
        expected = json.loads(target.read_text(encoding="utf-8"))["entries"]
        # The authorized development merge changes Python behavior. Keep the presentation
        # baseline immutable and apply only the individually recorded Python source changes.
        merge = json.loads(
            (root / "reports/dev-merge/protected-changes.json").read_text(encoding="utf-8")
        )
        if hashlib.sha256(target.read_bytes()).hexdigest() != merge["previousBaselineSha256"]:
            raise SystemExit("Historical presentation baseline changed")
        for name, hashes in merge["changes"].items():
            if not name.startswith("python/src/") or expected.get(name) != hashes["before"]:
                raise SystemExit(f"Invalid development merge boundary: {name}")
            expected[name] = hashes["after"]
        renamed = json.loads(
            (root / "reports/rename/protected-changes.json").read_text(encoding="utf-8")
        )
        if renamed["before"] != expected:
            raise SystemExit("Rename provenance does not match the preceding protected baseline")
        expected = renamed["after"]
        changes = json.loads(
            (root / "reports/applications/protected-changes.json").read_text("utf-8")
        )["changes"]
        for name, hashes in changes.items():
            if (
                name != "python/src/hardwareharness_backend/devices/mcp_client.py"
                or expected.get(name) != hashes["before"]
                or not hashes["reason"]
            ):
                raise SystemExit(f"Invalid applications integration exception: {name}")
            expected[name] = hashes["after"]

        # The approved applications stage replaces the engine, project envelope and IDE.
        # Keep the prior full snapshots as evidence and enforce the unaffected boundary.
        def protected(name: str) -> bool:
            return name.startswith(
                (
                    "python/src/hardwareharness_backend/devices/",
                    "python/src/hardwareharness_backend/wiring/",
                    "apps/desktop/src/main/opencode-",
                    "patches/",
                    "dependency:",
                )
            )

        expected = {name: value for name, value in expected.items() if protected(name)}
        actual = {name: value for name, value in actual.items() if protected(name)}
        # The user removed hardware ownership; preserve every other protected source.
        removal_path = root / "reports/lease-removal/changes.json"
        if hashlib.sha256(removal_path.read_bytes()).hexdigest() != (
            "3ac9226f7b9008bedf8e96ddc13c3ff66a4e48256ab8557a45ce252a536188bc"
        ):
            raise SystemExit("Hardware lease removal manifest changed")
        removal = json.loads(removal_path.read_text("utf-8"))
        allowed = {
            "python/src/hardwareharness_backend/devices/__init__.py",
            "python/src/hardwareharness_backend/devices/device_service.py",
            "python/src/hardwareharness_backend/devices/hardware_occupancy.py",
        }
        if set(removal["protectedChanges"]) != allowed or not removal["authorization"]:
            raise SystemExit("Invalid hardware lease removal boundary")
        for name, hashes in removal["protectedChanges"].items():
            if expected.get(name) != hashes["before"]:
                raise SystemExit(f"Hardware lease removal baseline mismatch: {name}")
            if hashes["after"] is None:
                expected.pop(name)
            else:
                expected[name] = hashes["after"]
        # The user authorized the full public MCP/prompt optimization. Retain every
        # preceding manifest and record only its six reviewed boundary changes.
        interface_path = root / "reports/agent-interface/protected-changes.json"
        if hashlib.sha256(interface_path.read_bytes()).hexdigest() != (
            "6b47ef15c6fb1453f9c82e73c89eedbfc686733f2138b41805ad4874b32933fe"
        ):
            raise SystemExit("Agent interface manifest changed")
        interface = json.loads(interface_path.read_text("utf-8"))
        interface_allowed = {
            "apps/desktop/src/main/opencode-agent-contract.test.ts",
            "apps/desktop/src/main/opencode-runtime.test.ts",
            "apps/desktop/src/main/opencode-runtime.ts",
            "python/src/hardwareharness_backend/devices/device_catalog_service.py",
            "python/src/hardwareharness_backend/devices/mcp_client.py",
            "python/src/hardwareharness_backend/wiring/project_wiring_service.py",
        }
        if (
            set(interface["changes"]) != interface_allowed
            or not interface["authorization"]
            or interface["previousLeaseManifestSha256"]
            != hashlib.sha256(removal_path.read_bytes()).hexdigest()
        ):
            raise SystemExit("Invalid agent interface boundary")
        for name, hashes in interface["changes"].items():
            if expected.get(name) != hashes["before"] or not hashes["reason"]:
                raise SystemExit(f"Agent interface baseline mismatch: {name}")
            expected[name] = hashes["after"]
        changed = [
            key for key in expected.keys() | actual.keys() if expected.get(key) != actual.get(key)
        ]
        if changed:
            raise SystemExit("Protected files changed:\n" + "\n".join(sorted(changed)))
    print(f"Protected source baseline: {len(actual)} entries verified")


if __name__ == "__main__":
    main()
