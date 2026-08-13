import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from testforge_runtime.config import load_config


class ConfigSecurityTests(unittest.TestCase):
    def load(self, values: dict):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "server.json"
            path.write_text(json.dumps({
                "serverId": "TEST",
                "hardwareId": "HW",
                "manufacturer": "Vendor",
                "model": "Model",
                "port": 8001,
                "token": "secret",
                **values,
            }), encoding="utf-8")
            with patch.dict(os.environ, {"TESTFORGE_SERVER_CONFIG": str(path)}, clear=True):
                return load_config()

    def test_defaults_to_loopback(self):
        self.assertEqual(self.load({}).host, "127.0.0.1")

    def test_rejects_unencrypted_remote_binding_by_default(self):
        with self.assertRaisesRegex(RuntimeError, "Refusing to expose"):
            self.load({"host": "0.0.0.0"})

    def test_allows_explicit_insecure_remote_binding(self):
        self.assertEqual(self.load({"host": "0.0.0.0", "allowInsecureRemote": True}).host, "0.0.0.0")


if __name__ == "__main__":
    unittest.main()
