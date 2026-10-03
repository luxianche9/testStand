"""A normal import keeps the frozen entry point's package-relative imports intact.

``--device-child`` runs one isolated device plugin (``Device.isolation = "subprocess"``)
instead of the service: the frozen executable is the only Python the installed app has.
"""

import sys

if __name__ == "__main__":
    if sys.argv[1:2] == ["--device-child"]:
        from teststand_device_sdk.plugin import child_main

        sys.exit(child_main())
    from teststand_backend.host.__main__ import main

    main()
