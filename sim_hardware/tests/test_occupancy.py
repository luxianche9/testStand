from __future__ import annotations

import time
import unittest
from threading import RLock

from testforge_sim_hardware.occupancy import HardwareOccupancy


class OccupancyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.safe_calls = 0
        self.lock = RLock()
        self.occupancy = HardwareOccupancy("HW1", self._safe, self.lock, ttl_seconds=0.12)

    def _safe(self) -> None:
        self.safe_calls += 1

    def test_acquire_heartbeat_release_and_conflict(self) -> None:
        acquired = self.occupancy.action("HW1", "acquire", "A", "Alice", "L1")
        self.assertEqual(acquired["holderId"], "A")
        with self.assertRaisesRegex(RuntimeError, "already occupied"):
            self.occupancy.action("HW1", "acquire", "B", "Bob", "L2")
        heartbeat = self.occupancy.action("HW1", "heartbeat", "A", None, "L1")
        self.assertEqual(heartbeat["state"], "occupied")
        released = self.occupancy.action("HW1", "release", "A", None, "L1")
        self.assertEqual(released, {"state": "unoccupied"})
        self.assertEqual(self.safe_calls, 1)

    def test_stale_release_and_heartbeat_do_not_affect_new_owner(self) -> None:
        self.occupancy.action("HW1", "acquire", "A", "Alice", "L1")
        self.occupancy.action("HW1", "release", "A", None, "L1")
        self.occupancy.action("HW1", "acquire", "B", "Bob", "L2")
        stale_release = self.occupancy.action("HW1", "release", "A", None, "L1")
        stale_heartbeat = self.occupancy.action("HW1", "heartbeat", "A", None, "L1")
        self.assertEqual(stale_release["holderId"], "B")
        self.assertEqual(stale_heartbeat["holderId"], "B")
        self.assertEqual(self.safe_calls, 1)

    def test_expiry_enters_safe_state_and_clears_lease(self) -> None:
        self.occupancy.action("HW1", "acquire", "A", "Alice", "L1")
        self.occupancy.start()
        time.sleep(0.7)
        status = self.occupancy.action("HW1", "status")
        self.occupancy.close()
        self.assertEqual(status, {"state": "unoccupied"})
        self.assertEqual(self.safe_calls, 1)


if __name__ == "__main__":
    unittest.main()
