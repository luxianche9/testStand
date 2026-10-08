from teststand_backend.host.change_events import change_summary


def test_project_event_carries_the_key_and_version_only() -> None:
    document = {
        "rootPath": "C:/p",
        "path": "C:/p/project.json",
        "dirty": False,
        "file": {"projectId": "P", "updatedAt": "2026-10-01T00:00:00Z", "wiring": {"nodes": []}},
    }
    assert change_summary("project", document) == {
        "projectId": "P",
        "updatedAt": "2026-10-01T00:00:00Z",
        "dirty": False,
    }
    assert change_summary("project", None) == {"projectId": None}


def test_wiring_and_confirmation_events_drop_the_resource_body() -> None:
    task = {"wiringTaskId": "W", "status": "pending", "operations": [{"kind": "connect"}]}
    assert change_summary("wiringTask", task) == {"wiringTaskId": "W", "status": "pending"}
    assert change_summary("confirmation", [{"confirmationId": "C"}]) == {"pending": 1}
    execution = {"state": "manual", "activityId": "A", "holders": [{"hardwareId": "H"}]}
    assert change_summary("execution", execution) == {"state": "manual", "activityId": "A"}


def test_already_small_events_keep_their_scalar_fields() -> None:
    run = {"runId": "R", "eventSequence": 3, "resultSequence": 1, "state": "running"}
    assert change_summary("testRun", run) == run
    assert change_summary("wiringChange", {"entryId": "E", "kind": "added", "extra": {"a": 1}}) == {
        "entryId": "E",
        "kind": "added",
    }
