"""testStand MCP adapter for the Advantech PCI-1762 relay card."""

from .adapter import Pci1762

DEVICE = Pci1762

__all__ = ["DEVICE", "Pci1762"]
