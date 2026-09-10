import inspect
import json
import re
from pathlib import Path
from typing import Any

import pytest

from testforge_backend.compat import Record, json_stringify
from testforge_backend.contracts.errors import to_wire_error
from testforge_backend.storage import ProjectRunLogStore

CASES: list[Record] = json.loads(Path(__file__).with_name("storage-golden.json").read_text("utf-8"))


def disk_files(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes().decode("utf-8")
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
@pytest.mark.asyncio
async def test_original_typescript_storage_golden(tmp_path: Path, case: Record) -> None:
    for relative, content in case.get("files", {}).items():
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content.encode("utf-8"))
    writes: list[Record] = []
    service = ProjectRunLogStore({**case.get("options", {}), "onWrite": writes.append})
    results: list[Record] = []
    for action in case["actions"]:
        method = re.sub(r"([A-Z])", lambda match: "_" + match[1].lower(), action["method"])
        result: Record
        try:
            value: Any = getattr(service, method)(tmp_path, *action["args"])
            if inspect.isawaitable(value):
                value = await value
            result = {"result": value}
        except Exception as error:
            result = {"error": to_wire_error(error)}
        if action.get("inspect"):
            result["files"] = disk_files(tmp_path)
        results.append(result)
    actual = {"results": results, "files": disk_files(tmp_path), "writes": writes}
    assert actual == case["expected"]
    assert json_stringify(actual, 2) + "\n" == case["expectedJson"]
