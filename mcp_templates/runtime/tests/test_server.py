import unittest
from types import SimpleNamespace

try:
    from testforge_runtime.server import TestForgeServerRuntime
except ModuleNotFoundError as error:
    TestForgeServerRuntime = None
    SERVER_IMPORT_ERROR = error
else:
    SERVER_IMPORT_ERROR = None


class DriverError(RuntimeError):
    def __init__(self, message: str, category: str = "driver", retryable: bool = False):
        super().__init__(message)
        self.category = category
        self.retryable = retryable


class Driver:
    capabilities = ("read", "write")
    state = "open"
    health = "healthy"
    driver_version = "1.2.3"
    actions = ()
    _state = "open"

    def open(self):
        pass

    def safe_stop(self):
        pass

    def shutdown(self):
        pass


@unittest.skipIf(TestForgeServerRuntime is None, f"optional MCP dependencies unavailable: {SERVER_IMPORT_ERROR}")
class ServerRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.config = SimpleNamespace(
            serverId="DEMO_MCP",
            hardwareId="DEMO.HW_0",
            manufacturer="Vendor",
            model="Model",
            host="127.0.0.1",
            port=8001,
            token="secret",
            simulate=True,
        )
        self.runtime = TestForgeServerRuntime(self.config, Driver(), "0.1.0")

    def test_invoke_preserves_driver_error_metadata(self):
        result = self.runtime.invoke(
            self.config.hardwareId,
            lambda: (_ for _ in ()).throw(DriverError("busy", retryable=True)),
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["category"], "driver")
        self.assertTrue(result["error"]["retryable"])

    def test_invoke_rejects_unknown_hardware(self):
        result = self.runtime.invoke("OTHER", lambda: None)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["category"], "invalid_argument")

    def test_summary_uses_the_single_configured_hardware(self):
        summary = self.runtime.summary()
        self.assertEqual(summary.hardwareId, self.config.hardwareId)
        self.assertEqual(summary.capabilities, Driver.capabilities)


if __name__ == "__main__":
    unittest.main()
