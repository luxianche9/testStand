"""``python -m hardwareharness_device_sdk --adapter <module[:attr]> [--config server.json] [--check]``."""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import sys

from .config import CONFIG_ENV, ServerConfig
from .device import Device


def load_device(spec: str) -> type[Device]:
    """``module`` exposes ``DEVICE``; ``module:Name`` selects another attribute."""
    module_name, _, attr = spec.partition(":")
    target = getattr(importlib.import_module(module_name), attr or "DEVICE")
    if not (isinstance(target, type) and issubclass(target, Device)):
        raise TypeError(f"{spec} is not a Device subclass")
    return target


def check(device_cls: type[Device]) -> int:
    """Run the compliance suite in-process against the dry-run simulator; never touches hardware.

    Failures break the contract (exit 1); warnings (missing pictures or description) do not.
    """
    from .testing import check_device, dry_run_config

    warnings: list[str] = []
    failures = check_device(device_cls, dry_run_config(device_cls), warnings=warnings)
    print(json.dumps({"adapter": f"{device_cls.__module__}.{device_cls.__name__}", "ok": not failures,
                      "failures": failures, "warnings": warnings}, ensure_ascii=False))
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="hardwareharness_device_sdk", description=__doc__)
    parser.add_argument("--adapter", required=True, help="Adapter module exposing DEVICE, or module:ClassName.")
    parser.add_argument("--config", help=f"server.json path; defaults to ${CONFIG_ENV}.")
    parser.add_argument("--check", action="store_true", help="Run the dry-run compliance suite and exit.")
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args(argv)
    logging.basicConfig(level=args.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    device_cls = load_device(args.adapter)
    if args.check:
        return check(device_cls)
    import uvicorn

    from .app import create_app

    config = ServerConfig.load(args.config)
    if not config.port:
        parser.error("server.json port is required")
    uvicorn.run(create_app(device_cls, config), host=config.host, port=config.port, log_level=args.log_level)
    return 0


if __name__ == "__main__":
    sys.exit(main())
