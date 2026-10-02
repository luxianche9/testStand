"""CAN decoding from DBC files (design §6.2: ``icd/*.dbc`` decoded by cantools).

``cantools`` is an optional dependency that is not installed by default. Everything here imports
it lazily and raises ``unavailable`` with an explanation when it is missing, so the rest of the
protocol layer works without it. Derived records use the same shapes as :mod:`.derived`
(``<alias>.<message>``, ``<alias>.<message>.<signal>``, ``<alias>.$errors``).

Frame ids follow §5.4 ``idScheme: can``: extended frames carry ``1 << 31``.
"""

from __future__ import annotations

import importlib
from collections.abc import Mapping
from typing import Any

from hardwareharness_backend.contracts.errors import app_error

from .derived import ERRORS, DerivedRecord, check_alias

CAN_EFF_FLAG = 1 << 31
CAN_ID_MASK = (1 << 29) - 1


def _cantools() -> Any:
    try:
        return importlib.import_module("cantools")
    except ImportError:
        raise app_error(
            "unavailable",
            "CAN DBC decoding needs the optional 'cantools' package, which is not installed",
        ) from None


def cantools_available() -> bool:
    try:
        _cantools()
    except Exception:
        return False
    return True


class DbcDecoder:
    """Decode ``frames`` records of a CAN stream with a DBC database."""

    def __init__(self, dbc_text: str, alias: str) -> None:
        check_alias(alias)
        cantools = _cantools()
        try:
            self.database = cantools.database.load_string(dbc_text, database_format="dbc")
        except Exception as error:
            raise app_error("validation_failed", f"Invalid DBC: {error}") from None
        self.alias = alias

    def feed(self, record: Mapping[str, Any]) -> list[DerivedRecord]:
        body: dict[str, Any] = {key: record[key] for key in ("t", "tb", "op") if key in record}
        body.update(seq=record.get("seq"), dir=str(record.get("dir") or "rx"), id=record.get("id"))
        raw = str(record.get("data") or "")
        body["raw"] = raw
        frame_id = record.get("id")
        if not isinstance(frame_id, int):
            return [self._error(body, "unmatched")]
        try:
            message = self.database.get_message_by_frame_id(frame_id & CAN_ID_MASK)
            signals = message.decode(bytes.fromhex(raw), decode_choices=True)
        except KeyError:
            return [self._error(body, "unmatched")]
        except Exception as error:
            return [self._error(body, "decode", str(error))]
        fields = {name: _plain(value) for name, value in signals.items()}
        base = f"{self.alias}.{message.name}"
        body.update(message=message.name, fields=fields, checksumOk=None)
        out = [DerivedRecord(base, body)]
        scalar: dict[str, Any] = {key: body[key] for key in ("t", "tb", "seq", "op") if key in body}
        for name, value in fields.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                out.append(DerivedRecord(f"{base}.{name}", {**scalar, "v": value}))
        return out

    def _error(self, body: dict[str, Any], reason: str, detail: str | None = None) -> DerivedRecord:
        body.update(reason=reason, checksumOk=None)
        if detail is not None:
            body["detail"] = detail
        return DerivedRecord(f"{self.alias}.{ERRORS}", body)


def _plain(value: Any) -> Any:
    """cantools returns ``NamedSignalValue`` for choices; keep plain JSON values."""
    if isinstance(value, (int, float, str, bool)) or value is None:
        return value
    return str(value)
