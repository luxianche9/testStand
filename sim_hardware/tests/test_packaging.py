from __future__ import annotations

import json
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PackagingTests(unittest.TestCase):
    def test_hardware_bundles_are_self_contained(self) -> None:
        expected = {
            "virtual-analog-input.tfhw": "SIM_PC.SIM_AI_0",
            "virtual-analog-output.tfhw": "SIM_PC.SIM_AO_0",
            "virtual-serial-card.tfhw": "SIM_PC.SIM_SERIAL_0",
        }

        for filename, hardware_id in expected.items():
            with self.subTest(filename=filename):
                with zipfile.ZipFile(ROOT / "hardware_bundles" / filename) as archive:
                    self.assertEqual(set(archive.namelist()), {"bundle.json", "hardware.json"})
                    manifest = json.loads(archive.read("bundle.json"))
                    hardware = json.loads(archive.read("hardware.json"))
                self.assertEqual(manifest["kind"], "hardware")
                self.assertEqual(manifest["id"], hardware_id)
                self.assertEqual(hardware["hardwareId"], hardware_id)

    def test_suite_archive_contains_no_testforge_source_or_runtime_state(self) -> None:
        with zipfile.ZipFile(ROOT / "output" / "sim-hardware.zip") as archive:
            names = archive.namelist()

        self.assertIn("hardware_bundles/virtual-analog-input.tfhw", names)
        self.assertIn("servers/analog_input/server.json.example", names)
        self.assertFalse(any(name.startswith("testForge/") for name in names))
        self.assertFalse(any(name.endswith("/server.json") for name in names))
        self.assertFalse(any("/.venv/" in f"/{name}" or "/node_modules/" in f"/{name}" for name in names))


if __name__ == "__main__":
    unittest.main()
