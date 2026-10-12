"""testStand device plugin for the Sinoder LJ-CO-CPCI-8 (entry point ``teststand.devices``)."""

from .adapter import LjCo8

DEVICE = LjCo8

__all__ = ["DEVICE", "LjCo8"]
