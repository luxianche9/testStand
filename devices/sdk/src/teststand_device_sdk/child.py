"""``python -m teststand_device_sdk.child``: one isolated device process (see :mod:`.plugin`)."""

import sys

from .plugin import child_main

if __name__ == "__main__":
    sys.exit(child_main())
