from __future__ import annotations

from collections.abc import Iterator

import pytest
from sse_starlette.sse import AppStatus


@pytest.fixture(autouse=True)
def _fresh_sse_shutdown_flag() -> Iterator[None]:
    """sse_starlette latches a process-wide flag once any uvicorn server stops.

    The service stops its Gateway once, at exit; tests start and stop many, so every SSE
    response after the first stop would close before its message without this reset.
    """
    AppStatus.should_exit = False
    yield
    AppStatus.should_exit = False
