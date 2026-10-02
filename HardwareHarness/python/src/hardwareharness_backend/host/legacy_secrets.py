"""Read secrets written by Electron ``safeStorage`` for the one-time keyring import (§4.7).

On Windows ``safeStorage`` is Chromium OSCrypt: the AES-256 key sits in the profile's
``Local State`` as base64 ``"DPAPI" + CryptProtectData(key)``, and each blob is
``b"v10" + 12-byte nonce + AES-GCM ciphertext and tag``.
"""

from __future__ import annotations

import base64
import ctypes
import json
import sys
from ctypes import wintypes
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PREFIX = b"v10"
NONCE = 12


class OsCryptReader:
    def __init__(self, key: bytes) -> None:
        self._cipher = AESGCM(key)

    @classmethod
    def from_profile(cls, user_data: Path) -> OsCryptReader | None:
        """The reader for ``user_data``, or ``None`` off Windows or without ``Local State``."""
        if sys.platform != "win32":
            return None
        try:
            state = json.loads((user_data / "Local State").read_text(encoding="utf-8"))
            protected = base64.b64decode(state["os_crypt"]["encrypted_key"])
        except (OSError, ValueError, KeyError, TypeError):
            return None
        if not protected.startswith(b"DPAPI"):
            return None
        return cls(_unprotect(protected[5:]))

    def decrypt(self, value: bytes) -> str:
        if not value.startswith(PREFIX):
            raise ValueError("Not an OSCrypt v10 blob")
        nonce, sealed = value[len(PREFIX) : len(PREFIX) + NONCE], value[len(PREFIX) + NONCE :]
        return self._cipher.decrypt(nonce, sealed, None).decode("utf-8")


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _unprotect(data: bytes) -> bytes:
    crypt32 = ctypes.windll.crypt32  # type: ignore[attr-defined,unused-ignore]
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined,unused-ignore]
    buffer = ctypes.create_string_buffer(data, len(data))
    source = _Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
    target = _Blob()
    if not crypt32.CryptUnprotectData(
        ctypes.byref(source), None, None, None, None, 0, ctypes.byref(target)
    ):
        raise OSError("CryptUnprotectData failed")
    try:
        return ctypes.string_at(target.pbData, target.cbData)
    finally:
        kernel32.LocalFree(target.pbData)
