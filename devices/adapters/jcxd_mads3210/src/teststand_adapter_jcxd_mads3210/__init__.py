"""testStand device plugin for the Devices-JC JCXD-MADS-CPCI-3210 (entry point ``teststand.devices``)."""

from .adapter import JcxdMads3210

DEVICE = JcxdMads3210

__all__ = ["DEVICE", "JcxdMads3210"]
