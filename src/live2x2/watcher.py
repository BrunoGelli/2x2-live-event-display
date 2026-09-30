"""Newest-ready-file watcher. Skips backlog; never treats HDF5-open as completion."""
from __future__ import annotations

import logging
from pathlib import Path
import time

from .cache import heartbeat, latest, prune
from .producer import Sampling, build, source_key, stamp

LOG = logging.getLogger(__name__)


def marker_ready(path: Path, suffix: str):
    try:
        marker = Path(str(path) + suffix)
        return marker.is_file() and marker.stat().st_mtime_ns >= path.stat().st_mtime_ns
    except FileNotFoundError:
        return False


class Watcher:
    """Call tick under a single writer lock. No whole-file/event scan per poll."""
    def __init__(self, directory: Path, cache: Path, options: Sampling, *, pattern="*.FLOW.hdf5",
                 recursive=False, completion="marker", marker_suffix=".done",
                 stable_seconds=120.0, retry_seconds=60.0, builder=build):
        if not directory.is_dir():
            raise ValueError(f"FLOW directory does not exist: {directory}")
        if completion not in ("marker", "stable"):
            raise ValueError("completion must be marker or stable")
        if not marker_suffix or "/" in marker_suffix:
            raise ValueError("marker suffix must be nonempty, without slashes")
        if stable_seconds <= 0 or retry_seconds <= 0:
            raise ValueError("stability and retry intervals must be positive")
        self.directory, self.cache, self.options = directory.resolve(), cache, options
        self.pattern, self.recursive = pattern, recursive
        self.completion, self.marker_suffix = completion, marker_suffix
        self.stable_seconds, self.retry_seconds, self.builder = stable_seconds, retry_seconds, builder
        self.observed, self.failed = {}, {}

    def tick(self, now=None):
        now = time.monotonic() if now is None else now
        paths = self.directory.rglob(self.pattern) if self.recursive else self.directory.glob(self.pattern)
        seen, ready = set(), []
        for path in paths:
            # Ignore transfer/temp names, directories and symlinks outside the selected tree.
            if any(part.startswith(".") for part in path.relative_to(self.directory).parts):
                continue
            if not path.is_file() or not path.resolve().is_relative_to(self.directory):
                continue
            try:
                source = stamp(path)
            except FileNotFoundError:
                continue
            seen.add(path)
            previous = self.observed.get(path)
            if previous is None or previous[0] != source:
                self.observed[path] = (source, now)
            if self.completion == "marker":
                complete = marker_ready(path, self.marker_suffix)
            else:
                complete = now - self.observed[path][1] >= self.stable_seconds
            if complete:
                ready.append((source["mtime_ns"], str(path), path, source))
        self.observed = {p: x for p, x in self.observed.items() if p in seen}
        current = latest(self.cache)
        if not ready:
            heartbeat(self.cache, "waiting")
            return None
        # "Latest" here means FLOW filesystem mtime, not an inferred acquisition timestamp.
        _, _, path, source = max(ready)
        key = source_key(source, self.options)
        if current and key == current["source_key"]:
            heartbeat(self.cache, "idle", candidate=path.name)
            return None
        if current and source["mtime_ns"] / 1e9 < current["source"]["mtime"]:
            heartbeat(self.cache, "waiting", candidate=path.name)
            return None
        if key in self.failed and now < self.failed[key]:
            heartbeat(self.cache, "retry_wait", error_code="publish_failed", candidate=path.name)
            return None
        heartbeat(self.cache, "building", candidate=path.name)
        try:
            def check():
                if self.completion == "marker" and not marker_ready(path, self.marker_suffix):
                    raise RuntimeError("Completion marker disappeared or is older than FLOW")
            result = self.builder(path, self.cache, self.options, self.completion, final_check=check)
            self.failed.clear()
            heartbeat(self.cache, "idle", candidate=path.name)
            prune(self.cache)
            LOG.info("Published %s: %s events, generation %s", path.name,
                     result["sampled_events"], result["generation"])
            return result
        except Exception:
            self.failed = {key: now + self.retry_seconds}
            heartbeat(self.cache, "error", error_code="publish_failed", candidate=path.name)
            LOG.exception("Publication failed for %s; keeping last good generation", path)
            return None
