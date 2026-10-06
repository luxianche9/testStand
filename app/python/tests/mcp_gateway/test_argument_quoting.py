"""Tool arguments some models send JSON-encoded twice."""

from teststand_backend.mcp_gateway.tool_registry import unquote_identifiers


def test_double_quoted_identifiers_are_unwrapped_and_text_is_kept() -> None:
    sent = {
        "hardwareId": '"PCI1762_CARD_0"',
        "path": '"C:\\bench\\pci1762-0.2.0.tsdev"',
        "toolName": '"teststand_create_test_plan"',
        "text": '"hello world"',
        "channel": 3,
        "plain": "PCI1762_CARD_0",
    }
    assert unquote_identifiers(sent) == {
        "hardwareId": "PCI1762_CARD_0",
        "path": "C:\\bench\\pci1762-0.2.0.tsdev",
        "toolName": "teststand_create_test_plan",
        "text": '"hello world"',
        "channel": 3,
        "plain": "PCI1762_CARD_0",
    }
