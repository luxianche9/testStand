"""testStand device plugin for the Devices-JC JCXD-DA-CPCI-6401 (entry point ``teststand.devices``)."""

from .adapter import JcxdDa6401

DEVICE = JcxdDa6401

__all__ = ["DEVICE", "JcxdDa6401"]
