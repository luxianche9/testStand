"""HardwareHarness MCP adapter for the Advantech PCI-1710L multifunction DAQ card."""

from .adapter import Pci1710l

DEVICE = Pci1710l

__all__ = ["DEVICE", "Pci1710l"]
