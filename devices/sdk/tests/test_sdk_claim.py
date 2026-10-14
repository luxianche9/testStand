"""Exclusive claims of physical resources across processes."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from teststand_device_sdk import DeviceError, claim_resource
from teststand_device_sdk.claim import CLAIMS_ENV


@pytest.fixture(autouse=True)
def claims_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv(CLAIMS_ENV, str(tmp_path))
    return tmp_path


def test_a_second_claim_fails_naming_the_holder_until_the_first_is_released() -> None:
    first = claim_resource("vendor/card0", owner="device A")
    with pytest.raises(DeviceError) as error:
        claim_resource("vendor/card0", owner="device B")
    assert error.value.category == "device_unreachable"
    assert "device A" in str(error.value)
    assert error.value.details["resource"] == "vendor/card0"
    first.release()
    with claim_resource("vendor/card0", owner="device B") as second:
        assert second.held
    assert not second.held


def test_different_resources_do_not_conflict() -> None:
    with claim_resource("vendor/card0"), claim_resource("vendor/card1"):
        pass


def test_another_process_cannot_claim_what_this_one_holds(claims_dir: Path) -> None:
    script = (
        "import sys\n"
        "from teststand_device_sdk import DeviceError, claim_resource\n"
        "try:\n"
        "    claim_resource('vendor/card0', owner='child')\n"
        "except DeviceError as error:\n"
        "    print('busy', error)\n"
        "    sys.exit(0)\n"
        "print('claimed')\n"
    )
    env = {**__import__("os").environ, CLAIMS_ENV: str(claims_dir)}
    with claim_resource("vendor/card0", owner="parent device"):
        result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, env=env, check=True)
        assert result.stdout.startswith("busy") and "parent device" in result.stdout
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, env=env, check=True)
    assert result.stdout.strip() == "claimed"
