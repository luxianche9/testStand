"""Scaffold a HardwareHarness MCP adapter from ``assets/adapter-template``.

    python skill/mcp-server/scripts/new_device.py pci1234 --prefix pci1234 --model PCI-1234 --manufacturer Acme

Creates ``mcp_servers/adapters/<adapter>/`` and registers the package in the
``mcp_servers`` uv workspace (``pyproject.toml``). The generated adapter is a
digital I/O skeleton that already passes the dry-run compliance suite; every
``TODO(new_device)`` marker must be resolved from the manual before review.
It never touches the terminal registry, never creates ``server.json`` and never deploys.
"""

from __future__ import annotations

import argparse
import re
import sys
import tomllib
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
TEMPLATE = SKILL / "assets" / "adapter-template"
REPO = SKILL.parents[1]
DEFAULT_ROOT = REPO / "mcp_servers"
SUFFIX = ".tmpl"

ADAPTER_ID = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
PREFIX = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
CLASS_NAME = re.compile(r"^[A-Z][A-Za-z0-9]*$")
SERVER_ID = re.compile(r"^[A-Z][A-Z0-9_]*$")


def class_name(adapter: str) -> str:
    """``cp118u_i`` -> ``Cp118uI``."""
    return "".join(part[:1].upper() + part[1:] for part in adapter.split("_"))


def sdk_range(root: Path) -> str:
    text = (root / "sdk" / "src" / "hardwareharness_device_sdk" / "_version.py").read_text(encoding="utf-8")
    match = re.search(r'__version__\s*=\s*"(\d+)\.(\d+)\.', text)
    if match is None:
        raise SystemExit("Cannot read the SDK version from sdk/src/hardwareharness_device_sdk/_version.py")
    major, minor = int(match[1]), int(match[2])
    return f">={major}.{minor},<{major}.{minor + 1}" if major == 0 else f">={major}.{minor},<{major + 1}"


def substitute(text: str, values: dict[str, str]) -> str:
    # Longest placeholders first so __PREFIX_UPPER__ is not split by __PREFIX__.
    for key in sorted(values, key=len, reverse=True):
        text = text.replace(key, values[key])
    return text


def render(dest: Path, values: dict[str, str]) -> list[Path]:
    written = []
    for source in sorted(TEMPLATE.rglob(f"*{SUFFIX}")):
        relative = substitute(source.relative_to(TEMPLATE).as_posix().removesuffix(SUFFIX), values)
        target = dest / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(substitute(source.read_text(encoding="utf-8"), values), encoding="utf-8", newline="\n")
        written.append(target)
    return written


def register(pyproject: Path, dist: str) -> bool:
    """Add ``dist`` to the workspace root dependencies and uv sources; False when already present."""
    text = pyproject.read_text(encoding="utf-8")
    newline = "\r\n" if b"\r\n" in pyproject.read_bytes() else "\n"
    data = tomllib.loads(text)
    dependencies = data["project"]["dependencies"]
    if dist in dependencies:
        return False
    match = re.search(r"^dependencies = \[(.*)\]$", text, flags=re.MULTILINE)
    if match is None or match[0].count("\n"):
        raise SystemExit(f"{pyproject}: expected a single-line 'dependencies = [...]'; add {dist!r} by hand")
    items = ", ".join(f'"{item}"' for item in [*dependencies, dist])
    text = text[:match.start()] + f"dependencies = [{items}]" + text[match.end():]
    # The table body ends at the first blank line or next table header.
    sources = re.search(r"^\[tool\.uv\.sources\]\n(?:[^\[\n].*\n)*", text, flags=re.MULTILINE)
    if sources is None:
        raise SystemExit(f"{pyproject}: [tool.uv.sources] not found; add {dist} = {{ workspace = true }} by hand")
    text = text[:sources.end()] + f"{dist} = {{ workspace = true }}\n" + text[sources.end():]
    tomllib.loads(text)  # never leave a broken workspace file behind
    pyproject.write_text(text, encoding="utf-8", newline=newline)
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("adapter", help="Adapter id = directory under adapters/, lowercase, e.g. pci1234 or cp118u_i.")
    parser.add_argument("--prefix", required=True, help="Tool name prefix, e.g. pci1234 -> pci1234_set_output.")
    parser.add_argument("--model", required=True, help="Model exactly as printed by the manufacturer, e.g. PCI-1234.")
    parser.add_argument("--manufacturer", required=True, help="Manufacturer, e.g. Advantech.")
    parser.add_argument("--class-name", help="Device class name; default derived from the adapter id.")
    parser.add_argument("--server-id", help="serverId; default <ADAPTER>_MCP.")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="mcp_servers directory.")
    parser.add_argument("--dest", type=Path, help="Write the adapter here instead of <root>/adapters/<adapter>.")
    parser.add_argument("--no-register", action="store_true", help="Do not edit <root>/pyproject.toml.")
    args = parser.parse_args(argv)

    adapter, prefix = args.adapter, args.prefix
    cls = args.class_name or class_name(adapter)
    server_id = args.server_id or f"{adapter.upper()}_MCP"
    checks = (("adapter id", adapter, ADAPTER_ID), ("prefix", prefix, PREFIX), ("class name", cls, CLASS_NAME),
              ("server id", server_id, SERVER_ID))
    problems = [f"{label} {value!r} must match {pattern.pattern}" for label, value, pattern in checks
                if not pattern.match(value)]
    if '"' in args.model + args.manufacturer or "\\" in args.model + args.manufacturer:
        problems.append("model and manufacturer must not contain quotes or backslashes")
    if problems:
        parser.error("; ".join(problems))

    root: Path = args.root.resolve()
    dest: Path = (args.dest or root / "adapters" / adapter).resolve()
    if dest.exists():
        parser.error(f"{dest} already exists; refusing to overwrite an adapter")
    package, dist = f"hh_adapter_{adapter}", f"hh-adapter-{adapter.replace('_', '-')}"
    values = {
        "__ADAPTER__": adapter, "__PACKAGE__": package, "__DIST__": dist, "__PREFIX__": prefix,
        "__PREFIX_UPPER__": prefix.upper(), "__CLASS__": cls, "__MODEL__": args.model,
        "__MANUFACTURER__": args.manufacturer, "__SERVER_ID__": server_id, "__SDK_RANGE__": sdk_range(root),
    }
    written = render(dest, values)
    registered = False if args.no_register else register(root / "pyproject.toml", dist)

    print(f"Created {dest} ({len(written)} files).")
    if registered:
        print(f"Registered {dist} in {root / 'pyproject.toml'}; run `uv sync` in {root}.")
    print(f"""
Next steps (see skill/mcp-server/SKILL.md):
  1. Replace every TODO(new_device) and the hypothetical digital I/O tools with the manual's operations.
  2. Run skill/mcp-server/scripts/check_adapter.ps1 -Adapter {adapter}  (pytest + compliance + TODO scan).
  3. Deployment to the bench is done by a human with the deploy button on the HardwareHarness
     Devices page (adapter "{adapter}", serverId "{server_id}", hardwareId, port) or with mcp_servers\\deploy.ps1.
     The terminal generates the remote server.json and token on first install; never write them here.""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
