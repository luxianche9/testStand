"""testStand device plugin for the ART Technology PXI2604 (entry point ``teststand.devices``)."""

from .adapter import ArtPxi2604

DEVICE = ArtPxi2604

__all__ = ["DEVICE", "ArtPxi2604"]
