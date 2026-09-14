"""A normal import keeps the frozen entry point's package-relative imports intact."""

from hardwareharness_backend.host.__main__ import main

if __name__ == "__main__":
    main()
