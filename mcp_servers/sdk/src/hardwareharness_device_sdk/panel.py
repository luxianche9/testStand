"""Widget templates returned by ``get_panel``.

A template is a suggestion the desktop canvas can drop as a freestanding
widget: it binds a widget kind to a stream (live display) and/or tools
(manual control). The canvas stores its own copy, so templates may evolve.
In ``write``/``actions`` arguments the string ``"$value"`` is replaced by the
widget's input value.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

WidgetKind = Literal["readout", "lamp", "toggle", "number", "select", "button", "terminal", "form"]
VALUE = "$value"


class ToolBinding(BaseModel):
    model_config = ConfigDict(frozen=True)

    tool: str = Field(description="Exact MCP tool name (short names are expanded with the device prefix).")
    args: dict[str, Any] = Field(default_factory=dict, description='Fixed arguments; "$value" is the widget input.')


class ValueRange(BaseModel):
    model_config = ConfigDict(frozen=True)

    min: float | None = None
    max: float | None = None
    step: float | None = None


class SelectOption(BaseModel):
    model_config = ConfigDict(frozen=True)

    value: Any
    label: str


class PanelItem(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str = Field(pattern=r"^[A-Za-z0-9_.:-]{1,80}$")
    label: str
    widget: WidgetKind
    group: str | None = None
    description: str = ""
    stream: str | None = Field(default=None, description="streamId shown live by the widget.")
    field: str | None = Field(default=None, description="Entry field to display, e.g. value; bit index via bit.")
    bit: int | None = Field(default=None, ge=0, le=63, description="Bit of an integer value shown by lamp/toggle.")
    bits: int | None = Field(default=None, ge=1, le=64, description="Bit count for a lamp row of an integer value.")
    read: ToolBinding | None = Field(default=None, description="Tool refreshing the value on demand.")
    write: ToolBinding | None = Field(default=None, description="Tool applying the widget input.")
    actions: dict[str, ToolBinding] = Field(default_factory=dict, description="Named extra actions, e.g. sendHex, configure.")
    unit: str | None = None
    decimals: int | None = Field(default=None, ge=0, le=9)
    range: ValueRange | None = None
    options: tuple[SelectOption, ...] = ()
    confirm: bool = Field(default=False, description="Ask the operator before writing (destructive actuation).")
    pins: tuple[str, ...] = Field(default=(), description="pinIds from get_pinout this widget relates to.")

    def tools(self) -> list[str]:
        bindings = [self.read, self.write, *self.actions.values()]
        return [binding.tool for binding in bindings if binding is not None]


def expand(item: PanelItem, prefix: str, known: set[str]) -> PanelItem:
    """Expand short tool names (``set_level`` -> ``pci1710l_set_level``) when the prefixed tool exists."""
    def resolve(binding: ToolBinding | None) -> ToolBinding | None:
        if binding is None or binding.tool in known:
            return binding
        full = f"{prefix}_{binding.tool}"
        return binding.model_copy(update={"tool": full}) if full in known else binding
    return item.model_copy(update={
        "read": resolve(item.read), "write": resolve(item.write),
        "actions": {key: resolve(value) for key, value in item.actions.items()},
    })
