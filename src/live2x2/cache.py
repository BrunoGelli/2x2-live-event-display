"""One writer, immutable generation directories, atomic latest pointer."""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
import uuid

SCHEMA = "live2x2.v1"
GENERATION = re.compile(r"^[0-9a-f]{32}$")


def read_json(path: Path):
    with path.open(encoding="utf-8") as stream:
        return json.load(stream)


def write_json(path: Path, value):
    """Atomic replacement on the same filesystem. Never emit NaN into JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, allow_nan=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        # Derived cache products only: readable by the web service's project UID/GID.
        os.chmod(name, 0o644)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextmanager
def writer_lock(cache: Path):
    """Advisory lock; keep this inode in place, even after a writer exits."""
    cache.mkdir(parents=True, exist_ok=True)
    with (cache / ".writer.lock").open("a+") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("Another worker owns this cache; use one writer per cache") from exc
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def latest(cache: Path):
    try:
        value = read_json(cache / "latest.json")
    except FileNotFoundError:
        return None
    if value.get("schema") != SCHEMA or not GENERATION.fullmatch(value.get("generation", "")):
        raise ValueError("Invalid latest cache catalog")
    return value


def heartbeat(cache: Path, state: str, *, error_code=None, candidate=None):
    # Exception strings and full filesystem paths belong only in private worker logs.
    write_json(cache / "worker.json", dict(schema=SCHEMA, updated_at=time.time(),
               state=state, error_code=error_code, candidate=candidate))


def publish(cache: Path, catalog: dict, events, *, final_check=lambda: None):
    """Caller holds writer_lock. A failed build never replaces latest.json."""
    root = cache / "generations"
    root.mkdir(parents=True, exist_ok=True)
    generation = uuid.uuid4().hex
    staging = Path(tempfile.mkdtemp(prefix=".building-", dir=root))
    final = root / generation
    try:
        rows = []
        for event in events:
            index = int(event["event_index"])
            write_json(staging / f"event-{index}.json", event)
            rows.append({k: event[k] for k in ("event_index", "event_id", "summary")})
        manifest = dict(catalog, schema=SCHEMA, generation=generation,
                        published_at=time.time(), events=rows, sampled_events=len(rows))
        write_json(staging / "catalog.json", manifest)
        final_check()
        os.chmod(staging, 0o755)
        os.replace(staging, final)
        write_json(cache / "latest.json", manifest)
        return manifest
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def prune(cache: Path, keep=12, grace_seconds=3600):
    """Only delete our old generations, with a grace period for paused viewers."""
    current = latest(cache)
    if current is None:
        return
    root = cache / "generations"
    entries = sorted((p for p in root.iterdir()
                      if p.is_dir() and not p.is_symlink() and GENERATION.fullmatch(p.name)),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    for path in entries[max(2, keep):]:
        if path.name == current["generation"] or time.time() - path.stat().st_mtime < grace_seconds:
            continue
        manifest = read_json(path / "catalog.json")
        if manifest.get("schema") == SCHEMA and manifest.get("generation") == path.name:
            shutil.rmtree(path)
