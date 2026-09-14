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
        changed = [
            key for key in expected.keys() | actual.keys() if expected.get(key) != actual.get(key)
        ]
        if changed:
            raise SystemExit("Protected files changed:\n" + "\n".join(sorted(changed)))
    print(f"Protected source baseline: {len(actual)} entries verified")


if __name__ == "__main__":
    main()
