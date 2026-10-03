"""testStand device plugin for the Moxa CP-118U-I 8-port serial card."""

from .adapter import Cp118uI

DEVICE = Cp118uI

__all__ = ["DEVICE", "Cp118uI"]
