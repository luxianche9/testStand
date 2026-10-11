"""testStand device plugin for the HTLT PXI68802W-I (entry point ``teststand.devices``)."""

from .adapter import HtltLvdt8

DEVICE = HtltLvdt8

__all__ = ["DEVICE", "HtltLvdt8"]
