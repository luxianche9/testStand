"""A normal import keeps the frozen entry point's package-relative imports intact.

``--device-child`` runs one isolated device plugin (``Device.isolation = "subprocess"``)
instead of the service: the frozen executable is the only Python the installed app has.
``--devkit`` checks or describes an adapter the agent wrote (teststand_backend.devkit.runner).
"""

import sys

if __name__ == "__main__":
    if sys.argv[1:2] == ["--device-child"]:
        from teststand_device_sdk.plugin import child_main

        sys.exit(child_main())
    if sys.argv[1:2] == ["--devkit"]:
        from teststand_backend.devkit.runner import main as devkit_main

        sys.exit(devkit_main(sys.argv[2:]))
    from teststand_backend.host.__main__ import main

    main()
