"""Schematic port and board drawings generated from pinout data (never photos).

Adapters ship the rendered SVG as a static file under ``assets/`` and attach it
to the connector with :func:`attach_port_image`; the ``pinPositions`` come from
the same geometry as the drawing, so the terminal can place pin markers on it.
An adapter test compares the shipped file with a fresh :func:`render_port`, so
the image cannot drift from the pinout. The drawings are schematic: pin
numbers and signals follow the cited manual; the note says what is unverified
(typically the view: mating face or solder side).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from xml.sax.saxutils import escape, quoteattr

from .pinout import ConnectorImage, Pin, PinPosition, Pinout

PITCH = 26.0
RADIUS = 9.0
FONT = 9.0
CHAR = 5.4
"""Approximate advance width of one label character at ``FONT``."""
MARGIN = 16.0
PAD = 10.0
GAP = 10.0
TITLE_HEIGHT = 46.0
LEGEND_HEIGHT = 46.0
COLORS = {"output": "#d9480f", "input": "#1971c2", "bidirectional": "#7048e8", "passive": "#2f9e44",
          "power": "#c92a2a", "ground": "#495057", "mode-dependent": "#f59f00", "nc": "#dee2e6"}
DEFAULT_NOTE = ("Schematic, not to scale. Pin numbers and signals per the cited manual; "
                "the view (mating face or solder side) is not verified.")
_STANDARD_DSUB = {9: (5, 4), 15: (8, 7), 25: (13, 12), 37: (19, 18), 50: (17, 16, 17)}
_HIGH_DENSITY_DSUB = {15: (5, 5, 5), 26: (9, 9, 8), 44: (15, 15, 14), 62: (21, 21, 20), 78: (20, 19, 20, 19)}


@dataclass(frozen=True)
class PortLayout:
    """Pin rows as drawn (left to right, top to bottom); ``offsets`` shift each row, in pitches."""

    kind: str
    rows: tuple[tuple[int, ...], ...]
    offsets: tuple[float, ...]
    shape: str = "rect"

    def __post_init__(self) -> None:
        if len(self.offsets) != len(self.rows):
            raise ValueError("one offset per row is required")
        positions = [position for row in self.rows for position in row]
        if len(set(positions)) != len(positions):
            raise ValueError("a pin position appears twice in the layout")


def _numbered(lengths: Sequence[int]) -> tuple[tuple[int, ...], ...]:
    rows, first = [], 1
    for length in lengths:
        rows.append(tuple(range(first, first + length)))
        first += length
    return tuple(rows)


def dsub(count: int, *, high_density: bool = False) -> PortLayout:
    """D-sub rows numbered 1.. from the top-left: e.g. DB-37 is 1-19 over 20-37."""
    table = _HIGH_DENSITY_DSUB if high_density else _STANDARD_DSUB
    if count not in table:
        raise ValueError(f"no {'high-density ' if high_density else ''}D-sub layout for {count} pins")
    lengths = table[count]
    if high_density:
        offsets = tuple(0.5 * index for index in range(len(lengths)))
    else:
        widest = max(lengths)
        offsets = tuple((widest - length) / 2 for length in lengths)
    kind = f"{'HD ' if high_density else ''}D-sub {count}"
    return PortLayout(kind, _numbered(lengths), offsets, "dsub")


def dual_row(count: int, kind: str | None = None) -> PortLayout:
    """Two rows (1..n/2 over n/2+1..n), e.g. a SCSI-68 or IDC header."""
    if count % 2:
        raise ValueError("a dual-row connector has an even pin count")
    return PortLayout(kind or f"{count}-pin dual row", _numbered((count // 2, count // 2)), (0.0, 0.0))


@dataclass(frozen=True)
class PortDiagram:
    svg: str
    positions: dict[int, tuple[float, float]]
    """Pin position -> normalized (x, y) centre on the image."""


def pin_label(pin: Pin) -> str:
    """Signal names of a pin; with several modes one entry per mode, ``-`` where the mode leaves it NC."""
    signals = ["-" if function.direction == "nc" else function.signal for function in pin.functions]
    if all(signal == "-" for signal in signals):
        return "NC"
    if len(set(signals)) == 1:
        return signals[0]
    return " / ".join(signals)


def pin_direction(pin: Pin) -> str:
    """The pin's direction; ``mode-dependent`` when its modes disagree, ``nc`` when no mode uses it."""
    directions = {function.direction for function in pin.functions if function.direction != "nc"}
    if len(directions) > 1:
        return "mode-dependent"
    return directions.pop() if directions else "nc"


def _connector_pins(pinout: Pinout, name: str) -> dict[int, Pin]:
    connector = next((item for item in pinout.connectors if item.name == name), None)
    if connector is None:
        raise ValueError(f"pinout has no connector named {name!r}")
    return {pin.position: pin for pin in pinout.pins if pin.connectorId == connector.connectorId}


def _text(x: float, y: float, value: str, *, size: float = FONT, anchor: str = "start", weight: str = "normal",
          rotate: bool = False, fill: str = "#212529") -> str:
    transform = f' transform="rotate(-90 {x:.1f} {y:.1f})"' if rotate else ""
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size:g}" text-anchor="{anchor}" font-weight="{weight}" '
            f'fill="{fill}"{transform}>{escape(value)}</text>')


def _header(width: float, height: float, title: str) -> list[str]:
    return [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" height="{height:.0f}" '
            f'viewBox="0 0 {width:.0f} {height:.0f}" font-family="Consolas, Menlo, monospace" role="img" '
            f'aria-label={quoteattr(title)}>',
            f"<title>{escape(title)}</title>",
            f'<rect width="{width:.0f}" height="{height:.0f}" fill="#ffffff"/>']


def render_port(pinout: Pinout, connector: str, layout: PortLayout, *, title: str,
                note: str = DEFAULT_NOTE) -> PortDiagram:
    """Draw one connector: numbered pins coloured by direction, rotated signal labels, a legend and a note."""
    pins = _connector_pins(pinout, connector)
    drawn = {position for row in layout.rows for position in row}
    if drawn != set(pins):
        raise ValueError(f"layout {layout.kind} does not cover the pins of {connector}: "
                         f"missing {sorted(set(pins) - drawn)}, extra {sorted(drawn - set(pins))}")
    labels = {position: pin_label(pin) for position, pin in pins.items()}
    label_height = max(len(label) for label in labels.values()) * CHAR + 6
    columns = max(offset + len(row) for offset, row in zip(layout.offsets, layout.rows, strict=True))
    width = max(2 * MARGIN + 2 * PAD + columns * PITCH, len(title) * 7.6 + 2 * MARGIN, len(note) * 5.4 + 2 * MARGIN)
    left = (width - columns * PITCH) / 2
    top_rows = (len(layout.rows) + 1) // 2
    top_label = TITLE_HEIGHT + label_height
    shell_top = top_label + GAP
    shell_height = 2 * PAD + 2 * RADIUS + (len(layout.rows) - 1) * PITCH
    bottom_label = shell_top + shell_height + GAP
    height = bottom_label + (label_height if len(layout.rows) > 1 else 0) + LEGEND_HEIGHT
    out = _header(width, height, title)
    out.append(_text(MARGIN, 22, title, size=13, weight="bold"))
    out.append(_text(MARGIN, 38, f"{layout.kind}, {len(pins)} pins; colour = signal direction", size=9,
                     fill="#495057"))
    shell_left, shell_right = left - PAD, left + columns * PITCH + PAD
    if layout.shape == "dsub":
        inset = PITCH / 2
        out.append(f'<path d="M {shell_left:.1f} {shell_top:.1f} H {shell_right:.1f} '
                   f'L {shell_right - inset:.1f} {shell_top + shell_height:.1f} '
                   f'H {shell_left + inset:.1f} Z" fill="#f1f3f5" stroke="#343a40" stroke-width="1.5" '
                   f'stroke-linejoin="round"/>')
    else:
        out.append(f'<rect x="{shell_left:.1f}" y="{shell_top:.1f}" width="{shell_right - shell_left:.1f}" '
                   f'height="{shell_height:.1f}" rx="6" fill="#f1f3f5" stroke="#343a40" stroke-width="1.5"/>')
    positions: dict[int, tuple[float, float]] = {}
    for index, (offset, row) in enumerate(zip(layout.offsets, layout.rows, strict=True)):
        cy = shell_top + PAD + RADIUS + index * PITCH
        above = index < top_rows
        for column, position in enumerate(row):
            cx = left + (offset + column + 0.5) * PITCH
            positions[position] = (round(cx / width, 4), round(cy / height, 4))
            colour = COLORS.get(pin_direction(pins[position]), COLORS["passive"])
            anchor_y = top_label if above else bottom_label
            start_y = cy - RADIUS if above else cy + RADIUS
            out.append(f'<line x1="{cx:.1f}" y1="{start_y:.1f}" x2="{cx:.1f}" y2="{anchor_y:.1f}" '
                       f'stroke="#adb5bd" stroke-width="0.8"/>')
            out.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{RADIUS:g}" fill="{colour}" stroke="#212529" '
                       f'stroke-width="0.8"/>')
            number_fill = "#212529" if colour == COLORS["nc"] else "#ffffff"
            out.append(_text(cx, cy + 3, str(position), size=8, anchor="middle", weight="bold", fill=number_fill))
            out.append(_text(cx + FONT * 0.35, anchor_y - 2 if above else anchor_y + 2, labels[position],
                             anchor="start" if above else "end", rotate=True))
    legend_y = height - LEGEND_HEIGHT + 16
    x = MARGIN
    used = {pin_direction(pin) for pin in pins.values()}
    for direction, colour in COLORS.items():
        if direction not in used:
            continue
        out.append(f'<circle cx="{x + 5:.1f}" cy="{legend_y - 3:.1f}" r="5" fill="{colour}" stroke="#212529" '
                   f'stroke-width="0.6"/>')
        out.append(_text(x + 14, legend_y, direction, size=9))
        x += 14 + len(direction) * CHAR + 18
    out.append(_text(MARGIN, legend_y + 18, note, size=8.5, fill="#495057"))
    out.append("</svg>")
    return PortDiagram("\n".join(out) + "\n", positions)


def attach_port_image(pinout: Pinout, connectors: str | Iterable[str], asset: str, diagram: PortDiagram) -> Pinout:
    """Return ``pinout`` with ``ConnectorImage(asset, pinPositions)`` set on the named connector(s)."""
    names = {connectors} if isinstance(connectors, str) else set(connectors)
    updated = []
    for connector in pinout.connectors:
        if connector.name in names:
            pins = _connector_pins(pinout, connector.name)
            placed = tuple(PinPosition(pinId=pins[position].pinId, x=x, y=y)
                           for position, (x, y) in sorted(diagram.positions.items()) if position in pins)
            connector = connector.model_copy(update={"image": ConnectorImage(asset=asset, pinPositions=placed)})
            names.discard(connector.name)
        updated.append(connector)
    if names:
        raise ValueError(f"pinout has no connector named {sorted(names)}")
    return pinout.model_copy(update={"connectors": tuple(updated)})


def render_board(title: str, facts: Sequence[str], bracket: Sequence[str], *,
                 note: str = "Schematic outline, not a photograph; proportions approximate.") -> str:
    """Appearance drawing of an expansion card: outline, edge connector, labelled bracket connectors."""
    width, height = 560.0, 300.0
    out = _header(width, height, title)
    out.append(_text(MARGIN, 24, title, size=14, weight="bold"))
    board_left, board_top, board_right, board_bottom = 70.0, 44.0, 540.0, 232.0
    out.append(f'<rect x="{board_left:g}" y="{board_top:g}" width="{board_right - board_left:g}" '
               f'height="{board_bottom - board_top:g}" rx="6" fill="#e6f4ea" stroke="#2b8a3e" stroke-width="2"/>')
    fingers_left = board_left + 150
    out.append(f'<rect x="{fingers_left:g}" y="{board_bottom:g}" width="230" height="16" fill="#f0c36d" '
               f'stroke="#b08900" stroke-width="1"/>')
    out.append(_text(fingers_left + 115, board_bottom + 30, "bus edge connector", size=9, anchor="middle",
                     fill="#495057"))
    out.append(f'<rect x="{board_left - 30:g}" y="{board_top - 14:g}" width="16" height="{board_bottom - board_top + 34:g}" '
               f'fill="#ced4da" stroke="#495057" stroke-width="1.2"/>')
    out.append(_text(board_left - 22, board_bottom + 34, "bracket", size=9, anchor="middle", fill="#495057"))
    slot = (board_bottom - board_top - 20) / max(len(bracket), 1)
    for index, label in enumerate(bracket):
        y = board_top + 10 + index * slot
        out.append(f'<rect x="{board_left - 34:g}" y="{y + 4:.1f}" width="24" height="{slot - 8:.1f}" rx="3" '
                   f'fill="#495057" stroke="#212529" stroke-width="1"/>')
        out.append(_text(board_left + 8, y + slot / 2 + 3, label, size=10, weight="bold"))
    for index, fact in enumerate(facts):
        out.append(_text(board_left + 170, board_top + 28 + index * 18, fact, size=10))
    out.append(_text(MARGIN, height - 14, note, size=9, fill="#495057"))
    out.append("</svg>")
    return "\n".join(out) + "\n"
