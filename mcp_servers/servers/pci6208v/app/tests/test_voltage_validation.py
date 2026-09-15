"""Reject nonfinite output requests before the native SDK boundary."""
from unittest.mock import Mock

import pytest

from hardwareharness_remote import pci6208v
from hardwareharness_remote.pci6208v_safety import clamp_volts


@pytest.mark.parametrize("volts", [float("nan"), float("inf"), float("-inf"), -10.01, 10.01])
def test_invalid_voltage_never_reaches_sdk(monkeypatch, volts):
    monkeypatch.setattr(pci6208v.STATE, "open", True)
    monkeypatch.setattr(pci6208v.STATE, "handle", 1)
    write = Mock(side_effect=AssertionError("invalid output must not reach hardware"))
    monkeypatch.setattr(pci6208v.sdk, "ao_vwrite_channel", write)
    assert not pci6208v.set_voltage(0, volts)["ok"]
    write.assert_not_called()


@pytest.mark.parametrize("volts", [float("nan"), float("inf"), float("-inf")])
def test_safe_configuration_rejects_nonfinite_values(volts):
    with pytest.raises(ValueError, match="finite"):
        clamp_volts(volts)
