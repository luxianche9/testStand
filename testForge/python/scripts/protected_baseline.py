"""Capture or verify source files excluded from the backend migration."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def snapshot(root: Path) -> dict[str, str]:
    """Hash protected source and pin the unchanged integration dependencies."""
    files = list((root / "apps/desktop/src/renderer").rglob("*"))
    files += list((root / "apps/desktop/src/main").glob("opencode-*.ts"))
    files += list((root / "patches").glob("*react-opencode*"))
    result = {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(files)
        if path.is_file()
    }
    package = json.loads((root / "apps/desktop/package.json").read_text(encoding="utf-8"))
    for name, version in package["dependencies"].items():
        if name == "@assistant-ui/react-opencode" or name.startswith("opencode-"):
            result[f"dependency:{name}"] = version
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("capture", "check"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    target = root / "python/reports/protected-files.json"
    actual = snapshot(root)
    if args.action == "capture":
        if target.exists():
            raise SystemExit("Protected baseline already exists; refusing to replace it")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(actual, indent=2) + "\n", encoding="utf-8")
    else:
        expected = json.loads(target.read_text(encoding="utf-8"))
        exceptions = root / "python/reports/protected-exceptions.json"
        if exceptions.exists():
            for key, entry in json.loads(exceptions.read_text(encoding="utf-8")).items():
                if expected.get(key) != entry["before"]:
                    raise SystemExit(f"Exception baseline does not match: {key}")
                expected[key] = entry["after"]
        changed = [
            key for key in expected.keys() | actual.keys() if expected.get(key) != actual.get(key)
        ]
        if changed:
            raise SystemExit("Protected files changed:\n" + "\n".join(sorted(changed)))
    print(f"Protected source baseline: {len(actual)} entries verified")


if __name__ == "__main__":
    main()
