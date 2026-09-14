"""Install the exact ICU used by Electron 36 into the local build input directory."""

from __future__ import annotations

import hashlib
import urllib.request
import zipfile
from pathlib import Path

URL = "https://github.com/unicode-org/icu/releases/download/release-74-2/icu4c-74_2-Win64-MSVC2019.zip"
SHA256 = "7d86f7911ea16eabc1ab4f57c2904fa97dada16cad39fa0630edbfe457c35ae6"


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    vendor = root / "vendor"
    vendor.mkdir(exist_ok=True)
    archive = vendor / "icu74.zip"
    if not archive.exists():
        urllib.request.urlretrieve(URL, archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        raise SystemExit("ICU 74.2 download checksum mismatch")
    target = vendor / "icu"
    with zipfile.ZipFile(archive) as bundle:
        for relative in ("bin64/icudt74.dll", "bin64/icuin74.dll", "bin64/icuuc74.dll", "LICENSE"):
            path = target / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            content = bundle.read(relative)
            if not path.exists() or path.read_bytes() != content:
                path.write_bytes(content)
    print(f"ICU 74.2 verified: {target}")


if __name__ == "__main__":
    main()
