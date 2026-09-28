from __future__ import annotations

import pytest
from sdk_demo import DemoDevice

from hardwareharness_device_sdk.testing import dry_run_config, serve


@pytest.fixture
def hh():
    with serve(DemoDevice) as harness:
        yield harness


@pytest.fixture
def config():
    return dry_run_config(DemoDevice)
