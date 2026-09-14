"""The deletion-stage gate must reject missing evidence and stale passing reports."""

from __future__ import annotations

import importlib.util
import json
import shutil
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest


def load_gate(name: str) -> ModuleType:
    path = Path(__file__).resolve().parents[1] / "scripts" / f"{name}.py"
    specification = importlib.util.spec_from_file_location(f"testforge_gate_{name}", path)
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


specs = load_gate("check_specs")
protection = load_gate("protected_baseline")


def copy_evidence(tmp_path: Path) -> Path:
    original = Path(__file__).resolve().parents[1]
    manifest = specs.verify_fixed_evidence(original)
    root = tmp_path / "python"
    names = [
        "python/reports/original-specification-evidence.json",
        *manifest["evidence"],
        *manifest["goldens"],
    ]
    for name in names:
        destination = tmp_path / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original.parent / name, destination)
    return root


def test_fixed_evidence_does_not_require_live_original_typescript(tmp_path: Path) -> None:
    root = copy_evidence(tmp_path)
    assert not (tmp_path / "packages").exists()
    assert not (tmp_path / "apps").exists()
    manifest = specs.verify_fixed_evidence(root)
    assert manifest["packageCaseCount"] == 117
    assert manifest["migrationCaseCount"] == 3
    assert manifest["sourceFileCount"] == 85


@pytest.mark.parametrize(
    "name",
    [
        "reports/original-specification-evidence.json",
        "reports/ts-assertion-inventory.json",
        "reports/ts-migration-assertion-inventory.json",
        "reports/coverage-baseline-by-package.json",
        "reports/stage-protected-files.json",
        "tests/contracts/contracts-golden.json",
    ],
)
def test_altered_fixed_evidence_is_rejected(tmp_path: Path, name: str) -> None:
    root = copy_evidence(tmp_path)
    path = root / name
    path.write_bytes(path.read_bytes() + b" ")
    with pytest.raises(SystemExit, match="evidence.*changed"):
        specs.verify_fixed_evidence(root)


def test_missing_original_assertions_are_rejected(tmp_path: Path) -> None:
    root = copy_evidence(tmp_path)
    (root / "reports/ts-assertion-inventory.json").unlink()
    with pytest.raises(SystemExit, match="evidence changed or missing"):
        specs.verify_fixed_evidence(root)


def passing_report(root: Path) -> dict[str, Any]:
    (root / "pyproject.toml").write_text("[project]\n")
    (root / "uv.lock").write_text("version = 1\n")
    hashes = specs.current_source_hashes(root)
    return {
        "exitstatus": 0,
        "sourceHashesBefore": hashes,
        "sourceHashesAfter": hashes,
        "tests": [{"nodeid": "tests/test_example.py::test_example", "outcome": "passed"}],
    }


def test_current_successful_report_is_accepted(tmp_path: Path) -> None:
    specs.verify_current_results(tmp_path, passing_report(tmp_path))


@pytest.mark.parametrize("when", ["before", "during", "new-test", "dependency"])
def test_stale_or_changing_python_inputs_are_rejected(tmp_path: Path, when: str) -> None:
    report = passing_report(tmp_path)
    if when == "before":
        report.pop("sourceHashesBefore")
    elif when == "during":
        report["sourceHashesAfter"] = {}
    elif when == "new-test":
        (tmp_path / "tests").mkdir()
        (tmp_path / "tests/test_new.py").write_text("def test_new(): assert False\n")
    else:
        (tmp_path / "uv.lock").write_text("version = 2\n")
    with pytest.raises(SystemExit, match="stale or its inputs changed"):
        specs.verify_current_results(tmp_path, report)


@pytest.mark.parametrize("outcome", ["failed", "skipped", "not-run"])
def test_incomplete_pytest_run_cannot_satisfy_the_gate(tmp_path: Path, outcome: str) -> None:
    report = passing_report(tmp_path)
    report["tests"][0]["outcome"] = outcome
    with pytest.raises(SystemExit, match="failed, skipped or unexecuted"):
        specs.verify_current_results(tmp_path, report)


def test_unsuccessful_pytest_session_cannot_satisfy_the_gate(tmp_path: Path) -> None:
    report = passing_report(tmp_path)
    report["exitstatus"] = 2
    with pytest.raises(SystemExit, match="did not complete successfully"):
        specs.verify_current_results(tmp_path, report)


def test_stage_protection_covers_behavior_and_allows_presentation(tmp_path: Path) -> None:
    protected = [
        "python/src/testforge_backend/domain.py",
        "apps/desktop/src/renderer/features/logic.ts",
        "apps/desktop/src/main/opencode-client.ts",
        "patches/@assistant-ui__react-opencode.patch",
    ]
    presentation = [
        "apps/desktop/src/renderer/features/Page.tsx",
        "apps/desktop/src/renderer/features/logic.test.ts",
        "apps/desktop/src/renderer/index.css",
    ]
    for name in [*protected, *presentation]:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("original")
    package = tmp_path / "apps/desktop/package.json"
    package.write_text(json.dumps({"dependencies": {"@assistant-ui/react-opencode": "0.2.18"}}))
    before = protection.snapshot(tmp_path)
    assert set(before) == {*protected, "dependency:dependencies:@assistant-ui/react-opencode"}
    for name in presentation:
        (tmp_path / name).write_text("presentation update")
    assert protection.snapshot(tmp_path) == before
    (tmp_path / protected[0]).write_text("behavior change")
    assert protection.snapshot(tmp_path) != before
