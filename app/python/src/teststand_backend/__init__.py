"""Python implementation of the testStand domain packages."""

from importlib.metadata import PackageNotFoundError, version

try:
    # One version for the release: pyproject.toml, kept equal to package.json by check-version.
    __version__ = version("teststand-backend")
except PackageNotFoundError:  # pragma: no cover - running from a source tree without metadata
    __version__ = "0.0.0"

CONTRACT_REVISION = "2026-09-16.2"
