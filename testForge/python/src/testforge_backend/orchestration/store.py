from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from functools import cmp_to_key
from typing import Any

from testforge_backend.compat import UNDEFINED, clone, js_trim, now_ms, utc_now_iso
from testforge_backend.compat.collation import locale_compare
from testforge_backend.contracts.orchestration import parse_test_run_list_query

from .utils import bounded_value

Json = dict[str, Any]


def date_ms(value: str) -> float:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return float("nan")


class RunStore:
    def __init__(self, mutation: Callable[[Json], None]) -> None:
        self.mutation = mutation
        self.runs: dict[str, Json] = {}
        self.nodes: dict[str, Json] = {}
        self.order: dict[str, list[str]] = {}
        self.events: dict[str, list[Json]] = {}
        self.next_event_ids: dict[str, int] = {}
        self.warnings: list[str] = []

    def clear(self) -> None:
        self.runs.clear()
        self.nodes.clear()
        self.order.clear()
        self.events.clear()
        self.next_event_ids.clear()
        self.warnings.clear()

    def add_warning(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)

    def insert_run(self, run: Json) -> None:
        run_id = run["runId"]
        self.order[run_id], self.events[run_id], self.next_event_ids[run_id] = [], [], 1
        self.update_run(run)

    def update_run(self, run: Json) -> None:
        self.runs[run["runId"]] = clone(run)
        self.mutation({"type": "run", "run": clone(run)})

    def get_run_record(self, run_id: str) -> Json:
        if run_id not in self.runs:
            raise ValueError(f"Unknown runId: {run_id}")
        return clone(self.runs[run_id])

    def get_run(
        self, run_id: str, since_event_id: int = 0, node_offset: int = 0, node_limit: int = 200
    ) -> Json:
        order = self.order.get(run_id, [])
        offset = max(node_offset, 0)
        return {
            "run": self.get_run_record(run_id),
            "nodeRuns": [
                clone(self.nodes[key])
                for key in order[offset : offset + min(max(node_limit, 1), 500)]
            ],
            "events": [
                clone(event)
                for event in self.events.get(run_id, [])
                if event["eventId"] > since_event_id
            ],
            "nodeTotal": len(order),
        }

    def list_runs(self, raw: Json | None = None) -> Json:
        query = parse_test_run_list_query(raw or {})
        runs = list(self.runs.values())

        def compare_names(a: str, b: str) -> int:
            return locale_compare(a, b, "zh")

        names = sorted({str(run["taskName"]) for run in runs}, key=cmp_to_key(compare_names))
        search = js_trim(query.get("search", "")).lower()
        filtered = [
            run
            for run in runs
            if (not query.get("statuses") or run["status"] in query["statuses"])
            and ("from" not in query or date_ms(run["createdAt"]) >= date_ms(query["from"]))
            and ("to" not in query or date_ms(run["createdAt"]) <= date_ms(query["to"]))
            and (not query.get("taskName") or run["taskName"] == query["taskName"])
            and (
                not search
                or any(
                    search in value.lower()
                    for value in [
                        run["runId"],
                        run["taskName"],
                        run.get("summary", {}).get("message", ""),
                    ]
                )
            )
        ]

        def key(run: Json) -> str:
            by = query["sortBy"]
            if by in {"taskName", "status"}:
                return str(run[by])
            if by == "failedNodes":
                return str(run.get("summary", {}).get("failedNodes", 0)).zfill(8)
            if by == "duration":
                start = date_ms(str(run.get("startedAt", run["createdAt"])))
                end = date_ms(run["completedAt"]) if "completedAt" in run else now_ms()
                return str(int(max(0, end - start))).zfill(16)
            return str(run["createdAt"])

        def compare(left: Json, right: Json) -> int:
            primary = locale_compare(key(left), key(right), "zh", numeric=True)
            return (
                primary * (1 if query["sortDir"] == "asc" else -1)
                if primary
                else locale_compare(right["runId"], left["runId"])
            )

        filtered.sort(key=cmp_to_key(compare))
        return {
            "items": clone(filtered[query["offset"] : query["offset"] + query["limit"]]),
            "total": len(filtered),
            "warnings": list(self.warnings),
            "taskNames": names,
        }

    def insert_node(self, node: Json) -> None:
        self.order.setdefault(node["runId"], []).append(node["nodeRunId"])
        self.save_node(node)

    def save_node(self, node: Json) -> None:
        self.nodes[node["nodeRunId"]] = clone(node)
        self.mutation({"type": "nodeRun", "nodeRun": clone(node)})

    def get_node(self, node_id: str) -> Json:
        if node_id not in self.nodes:
            raise ValueError(f"Unknown nodeRunId: {node_id}")
        return clone(self.nodes[node_id])

    def list_nodes(self, run_id: str) -> list[Json]:
        return [clone(self.nodes[key]) for key in self.order.get(run_id, [])]

    def find_node(
        self, run_id: str, node_id: str, branch: str, iteration: list[int], status: str
    ) -> Json | None:
        return next(
            (
                node
                for node in self.list_nodes(run_id)
                if node["nodeId"] == node_id
                and node["branchPath"] == branch
                and node["iterationPath"] == iteration
                and node["status"] == status
            ),
            None,
        )

    def list_operator_decisions(self) -> list[Json]:
        def compare_nodes(a: Json, b: Json) -> int:
            return locale_compare(a.get("startedAt", ""), b.get("startedAt", ""))

        nodes = sorted(
            [
                node
                for node in self.nodes.values()
                if node["status"] == "waiting_operator" and node.get("decision")
            ],
            key=cmp_to_key(compare_nodes),
        )
        return [
            {
                "nodeRunId": node["nodeRunId"],
                "runId": node["runId"],
                "nodeId": node["nodeId"],
                "prompt": node["decision"]["prompt"],
                "options": clone(node["decision"]["options"]),
            }
            for node in nodes
        ]

    def add_event(self, run_id: str, kind: str, data: Any = UNDEFINED) -> Json:
        event: Json = {
            "eventId": self.next_event_ids.get(run_id, 1),
            "runId": run_id,
            "timestamp": utc_now_iso(),
            "type": kind,
        }
        if data is not UNDEFINED:
            event["data"] = bounded_value(data)
        self.next_event_ids[run_id] = event["eventId"] + 1
        self.events.setdefault(run_id, []).append(clone(event))
        self.mutation({"type": "events", "runId": run_id, "events": [clone(event)]})
        return clone(event)

    def summary(self, run_id: str, message: str | None = None) -> Json:
        nodes = self.list_nodes(run_id)
        return {
            "passedNodes": sum(node["status"] == "passed" for node in nodes),
            "failedNodes": sum(node["status"] == "failed" for node in nodes),
            "cancelledNodes": sum(node["status"] == "cancelled" for node in nodes),
            **({"message": message} if message else {}),
        }

    def load_archive(self, archive: Json) -> None:
        run_id = archive["run"]["runId"]
        if run_id in self.runs:
            self.add_warning(f"{run_id}: duplicate Run archive")
            return
        self.runs[run_id] = clone(archive["run"])
        order: list[str] = []
        for node in archive["nodeRuns"]:
            if node["nodeRunId"] in self.nodes:
                self.add_warning(f"{run_id}: duplicate nodeRunId {node['nodeRunId']}")
                continue
            self.nodes[node["nodeRunId"]] = clone(node)
            order.append(node["nodeRunId"])
        self.order[run_id] = order
        self.events[run_id] = sorted(clone(archive["events"]), key=lambda event: event["eventId"])
        self.next_event_ids[run_id] = (
            max([0, *[event["eventId"] for event in self.events[run_id]]]) + 1
        )

    def archive(self, run_id: str) -> Json:
        return {
            "formatVersion": 1,
            "run": self.get_run_record(run_id),
            "nodeRuns": self.list_nodes(run_id),
            "events": clone(self.events.get(run_id, [])),
        }

    def remove_run(self, run_id: str) -> None:
        for key in self.order.pop(run_id, []):
            self.nodes.pop(key, None)
        self.events.pop(run_id, None)
        self.next_event_ids.pop(run_id, None)
        self.runs.pop(run_id, None)
