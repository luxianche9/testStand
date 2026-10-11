"""testStand device plugin for the Devices-JC JCXD-RS-CPCI-8MI (entry point ``teststand.devices``)."""

from .adapter import JcxdRsx8

DEVICE = JcxdRsx8

__all__ = ["DEVICE", "JcxdRsx8"]
