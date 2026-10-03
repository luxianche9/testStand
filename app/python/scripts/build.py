"""Freeze the backend from a stable working directory on developer machines and CI."""

import subprocess
import sys
from pathlib import Path


def main() -> int:
    return subprocess.call(
        [sys.executable, "-m", "PyInstaller", "--noconfirm", "backend.spec"],
        cwd=Path(__file__).resolve().parents[1],
    )


if __name__ == "__main__":
    raise SystemExit(main())
