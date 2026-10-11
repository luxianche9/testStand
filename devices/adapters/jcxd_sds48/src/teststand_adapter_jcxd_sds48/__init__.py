"""testStand device plugin for the Devices-JC JCXD-SDS48-CPCI (entry point ``teststand.devices``)."""

from .adapter import JcxdSds48

DEVICE = JcxdSds48

__all__ = ["DEVICE", "JcxdSds48"]
