"""testStand device plugin: a link over the PC's COM port, TCP or UDP (entry point ``teststand.devices``)."""

from .adapter import CommLink

DEVICE = CommLink

__all__ = ["DEVICE", "CommLink"]
