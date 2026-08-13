import asyncio
import unittest

from testforge_runtime.shutdown import prepare_safe_shutdown


class Driver:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self._state = "active"

    def safe_stop(self):
        if self.fail:
            raise RuntimeError("unsafe")


class SafeShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_exits_after_safe_stop_succeeds(self):
        exited = asyncio.Event()
        result = await prepare_safe_shutdown(
            Driver(), "HW", lambda error: {"message": str(error)}, lambda: "now",
            exit_process=exited.set, delay=0,
        )
        await asyncio.wait_for(exited.wait(), timeout=1)
        self.assertTrue(result["ok"])

    async def test_does_not_exit_after_safe_stop_fails(self):
        exited = False

        def mark_exited():
            nonlocal exited
            exited = True

        result = await prepare_safe_shutdown(
            Driver(fail=True), "HW", lambda error: {"message": str(error)}, lambda: "now",
            exit_process=mark_exited, delay=0,
        )
        await asyncio.sleep(0)
        self.assertFalse(result["ok"])
        self.assertFalse(exited)


if __name__ == "__main__":
    unittest.main()
