"""ECMAScript collation backed by the desktop's pinned ICU 74.2 runtime."""

from __future__ import annotations

import ctypes
import os
import sys
from functools import lru_cache
from pathlib import Path

_default_locale = "zh-CN"


def set_default_locale(locale: str) -> None:
    global _default_locale
    _default_locale = locale


@lru_cache(maxsize=1)
def _library() -> ctypes.CDLL:
    explicit = os.environ.get("HARDWAREHARNESS_ICU_DIR")
    bundle = getattr(sys, "_MEIPASS", None)
    directory = (
        Path(explicit)
        if explicit
        else Path(bundle) / "icu"
        if bundle
        else Path(__file__).resolve().parents[3] / "vendor" / "icu" / "bin64"
    )
    if sys.platform == "win32":
        # Load dependencies by absolute path: never pick up a different system ICU.
        for name in ["icudt74.dll", "icuuc74.dll"]:
            ctypes.CDLL(str(directory / name))
        library = ctypes.CDLL(str(directory / "icuin74.dll"))
    else:
        library = ctypes.CDLL(str(directory / "libicui18n.so.74"))
    library.ucol_open_74.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_int32)]
    library.ucol_open_74.restype = ctypes.c_void_p
    library.ucol_setAttribute_74.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int32,
        ctypes.c_int32,
        ctypes.POINTER(ctypes.c_int32),
    ]
    library.ucol_setAttribute_74.restype = None
    library.ucol_strcoll_74.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_int32,
        ctypes.c_void_p,
        ctypes.c_int32,
    ]
    library.ucol_strcoll_74.restype = ctypes.c_int32
    library.ucol_close_74.argtypes = [ctypes.c_void_p]
    library.ucol_close_74.restype = None
    return library


class _Collator:
    def __init__(self, locale: str, numeric: bool) -> None:
        self.library = _library()
        error = ctypes.c_int32(0)
        self.handle = self.library.ucol_open_74(
            locale.replace("-", "_").encode("ascii"), ctypes.byref(error)
        )
        if error.value > 0 or not self.handle:
            raise RuntimeError(f"ICU cannot open locale {locale}: {error.value}")
        for attribute, value in [
            (7, 17 if numeric else 16),
            (4, 17),
            (1, 21),
            (2, 16),
            (3, 16),
            (5, 2),
        ]:
            self.library.ucol_setAttribute_74(self.handle, attribute, value, ctypes.byref(error))
        if error.value > 0:
            raise RuntimeError(f"ICU cannot configure locale {locale}: {error.value}")

    def compare(self, left: str, right: str) -> int:
        a = left.encode("utf-16-le", "surrogatepass")
        b = right.encode("utf-16-le", "surrogatepass")
        return int(self.library.ucol_strcoll_74(self.handle, a, len(a) // 2, b, len(b) // 2))

    def __del__(self) -> None:
        if getattr(self, "handle", None):
            self.library.ucol_close_74(self.handle)


@lru_cache(maxsize=32)
def _collator(locale: str, numeric: bool) -> _Collator:
    return _Collator(locale, numeric)


def locale_compare(a: str, b: str, locale: str | None = None, numeric: bool = False) -> int:
    return _collator(locale or _default_locale, numeric).compare(a, b)
