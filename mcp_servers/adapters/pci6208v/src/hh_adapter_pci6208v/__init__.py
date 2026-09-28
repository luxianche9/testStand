"""HardwareHarness MCP adapter for the ADLINK PCI-6208V analog output card."""

from .adapter import Pci6208v

DEVICE = Pci6208v

__all__ = ["DEVICE", "Pci6208v"]
