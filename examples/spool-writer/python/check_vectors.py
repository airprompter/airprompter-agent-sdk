#!/usr/bin/env python3
"""Drives spool_writer.py through protocol/vectors/spool.json: buckets, minutes, segment names, rotation, and the
minute-window aggregation (compared as sets), then writes one case to a temp directory and reads the sealed segment
back. Exit 1 on the first mismatch. Run by conformance/run.mjs; standalone::

    python3 examples/spool-writer/python/check_vectors.py protocol/vectors/spool.json
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from spool_writer import LATENCY_BUCKET_EDGES_MS, SEGMENT_MAX_BYTES, SpoolWriter, epoch_minute, latency_bucket_index, minute_of, segment_name  # noqa: E402


def stable(value):
    if isinstance(value, dict):
        return {k: stable(value[k]) for k in sorted(value)}
    if isinstance(value, list):
        return [stable(v) for v in value]
    return value


def window_key(row):
    return json.dumps([row["minute"], row["tag"], row["versionId"], row["arm"], row["model"], row["status"], row.get("errorClass")])


def main(path: str) -> int:
    with open(path, encoding="utf-8") as handle:
        sp = json.load(handle)
    assert sp["latencyBuckets"]["edges"] == LATENCY_BUCKET_EDGES_MS and sp["segmentMaxBytes"] == SEGMENT_MAX_BYTES, "edges / segment cap"
    for case in sp["latencyBuckets"]["cases"]:
        assert latency_bucket_index(case["latencyMs"]) == case["bucket"], f"bucket {case['latencyMs']}"
    for case in sp["minutes"]:
        assert minute_of(case["epochMs"]) == case["minute"] and epoch_minute(case["epochMs"]) == case["epochMinute"], case["name"]
    for case in sp["segmentNames"]:
        assert segment_name(case["instanceId"], epoch_minute(case["epochMs"]), case["n"]) == case["name"], case["name"]
    for case in sp["rotation"]:
        writer = SpoolWriter(instance_id=case["instanceId"])
        for i, append in enumerate(case["appends"]):
            assert writer.plan_segment(append["epochMs"], append["lineBytes"]) == (append["segment"], append["rotated"]), f"rotation {case['name']} append {i}"
    for case in sp["windows"]:
        writer = SpoolWriter(instance_id=case["instanceId"], instance_class=case["instanceClass"], sdk=case["sdk"])
        for event in case["events"]:
            if event["kind"] == "observe":
                o = event["observation"]
                writer.observe(tag=o["tag"], version_id=o["versionId"], arm=o.get("arm", "none"), model=o["model"], status=o.get("status", "ok"), error_class=o.get("errorClass"), usage_source=o.get("usageSource", "reported"), latency_ms=o["latencyMs"], tokens=o.get("tokens"), checks=o.get("checks"), outcomes=o.get("outcomes"), at=event["at"])
            elif event["kind"] == "feedback":
                f = event["feedback"]
                writer.feedback(tag=f["tag"], version_id=f["versionId"], arm=f.get("arm", "none"), model=f["model"], outcomes=f["outcomes"], at=event["at"])
            elif event["kind"] == "close":
                writer.close(event["at"])
        got = sorted((stable(r) for r in writer.emitted), key=window_key)
        expected = sorted((stable(r) for r in case["expectedWindows"]), key=window_key)
        assert got == expected, f"windows {case['name']}:\n  got      {json.dumps(got)}\n  expected {json.dumps(expected)}"
    # One case through the filesystem: a sealed segment, no `.open` left behind, rows parse back.
    case = sp["windows"][0]
    with tempfile.TemporaryDirectory() as tmp:
        writer = SpoolWriter(dir=tmp, instance_id=case["instanceId"], instance_class=case["instanceClass"], sdk=case["sdk"])
        for event in case["events"]:
            if event["kind"] == "observe":
                o = event["observation"]
                writer.observe(tag=o["tag"], version_id=o["versionId"], arm=o.get("arm", "none"), model=o["model"], status=o.get("status", "ok"), error_class=o.get("errorClass"), latency_ms=o["latencyMs"], tokens=o.get("tokens"), checks=o.get("checks"), at=event["at"])
            elif event["kind"] == "feedback":
                f = event["feedback"]
                writer.feedback(tag=f["tag"], version_id=f["versionId"], arm=f.get("arm", "none"), model=f["model"], outcomes=f["outcomes"], at=event["at"])
            elif event["kind"] == "close":
                writer.close(event["at"])
        files = sorted(os.listdir(tmp))
        assert files and all(f.endswith(".ndjson") for f in files), f"sealed segments only: {files}"
        with open(os.path.join(tmp, files[0]), encoding="utf-8") as handle:
            rows = [json.loads(line) for line in handle if line.strip()]
        assert sorted((stable(r) for r in rows), key=window_key) == sorted((stable(r) for r in case["expectedWindows"]), key=window_key), "rows read back"
    print(f"ok: spool_writer.py passes {len(sp['windows'])} window cases, {len(sp['rotation'])} rotation cases")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "..", "protocol", "vectors", "spool.json")))
