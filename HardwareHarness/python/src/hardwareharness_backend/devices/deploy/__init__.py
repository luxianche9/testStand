"""Deploying services to Windows computers from the terminal (design doc 4.8.3, DEC-07)."""

from .bundle import Bundle as Bundle
from .bundle import assemble as assemble
from .bundle import list_adapters as list_adapters
from .bundle import load_bundle as load_bundle
from .bundle import mcp_source_root as mcp_source_root
from .pipeline import DeployOutcome as DeployOutcome
from .pipeline import DeploySpec as DeploySpec
from .pipeline import RemoteHost as RemoteHost
from .service import DeployService as DeployService
