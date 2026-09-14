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
        changed = [
            key for key in expected.keys() | actual.keys() if expected.get(key) != actual.get(key)
        ]
        if changed:
            raise SystemExit("Protected files changed:\n" + "\n".join(sorted(changed)))
    print(f"Protected source baseline: {len(actual)} entries verified")


if __name__ == "__main__":
    main()
