"""``python -m teststand_device_sdk --adapter <type|module[:attr]> --check``: the dry-run compliance suite."""

from __future__ import annotations

import argparse
import json
import logging
import sys

from .device import Device
from .device_types import load_device


def check(device_cls: type[Device]) -> int:
    """Run the compliance suite in-process against the dry-run simulator; never touches hardware.

    Failures break the contract (exit 1); warnings (missing description, idle streams) do not.
    """
    from .testing import check_device, dry_run_config

    warnings: list[str] = []
    failures = check_device(device_cls, dry_run_config(device_cls), warnings=warnings)
    print(json.dumps({"adapter": f"{device_cls.__module__}.{device_cls.__name__}", "ok": not failures,
                      "failures": failures, "warnings": warnings}, ensure_ascii=False))
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="teststand_device_sdk", description=__doc__)
    parser.add_argument("--adapter", required=True, help="Device type, adapter module exposing DEVICE, or module:ClassName.")
    parser.add_argument("--check", action="store_true", required=True,
                        help="Run the dry-run compliance suite and exit.")
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args(argv)
    logging.basicConfig(level=args.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    return check(load_device(args.adapter))


if __name__ == "__main__":
    sys.exit(main())
