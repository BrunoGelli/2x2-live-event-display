"""Read only sampled FLOW events; do not scan every event or apply physics cuts."""
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path
import time

import numpy as np

from . import __version__
from .cache import SCHEMA, publish

UPSTREAM_COMMIT = "0400d9b788d4515bee9a22b230df08937475d0ef"


@dataclass(frozen=True)
class Sampling:
    sample_size: int = 60
    max_hits: int = 20000
    seed: int = 0
    hit_type: str = "prompt"
    block_rows: int = 16384

    def __post_init__(self):
        if not 1 <= self.sample_size <= 1000:
            raise ValueError("sample-size must be 1..1000")
        if not 1 <= self.max_hits <= 100000:
            raise ValueError("max-hits must be 1..100000")
        if self.seed < 0 or self.block_rows < 1:
            raise ValueError("seed must be nonnegative and block-rows positive")
        if self.hit_type not in ("prompt", "final"):
            raise ValueError("hit-type must be prompt or final")


def stamp(path: Path):
    path = path.resolve(strict=True)
    info = path.stat()
    return dict(path=str(path), size=info.st_size, mtime_ns=info.st_mtime_ns,
                inode=info.st_ino)


def source_key(source: dict, options: Sampling):
    payload = json.dumps(dict(source=source, sampling=asdict(options),
                              schema=SCHEMA, app=__version__, reader=UPSTREAM_COMMIT), sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def upstream():
    try:
        from ucd2x2.core.hot_pixels import EventHitReader
        from ucd2x2.core.geometry import module_boxes_cm
    except ImportError as exc:
        raise RuntimeError("FLOW worker needs the pinned reader: pip install -e '.[worker]'") from exc
    return EventHitReader, module_boxes_cm


def sample_indices(n_events: int, size: int, seed: int):
    """Uniform without replacement, including empty/noisy event rows."""
    return np.random.default_rng(seed).choice(n_events, min(size, n_events), replace=False).tolist()


def geometry_payload(boxes):
    return {
        "units": "cm", "source": "ucd2x2 nominal module boxes",
        "upstream_commit": UPSTREAM_COMMIT,
        "boxes": [{"module": str(k), **asdict(box)} for k, box in boxes.items()],
        "bounds": {axis: [min(getattr(b, axis + "min") for b in boxes.values()) - 2,
                          max(getattr(b, axis + "max") for b in boxes.values()) + 2]
                   for axis in "xyz"},
    }


def event_payload(hits, index, event_id, boxes, max_hits, seed):
    missing = set(("x", "y", "z", "Q")) - set(hits.dtype.names or ())
    if missing:
        raise ValueError(f"Calibrated FLOW hit fields missing: {sorted(missing)}")
    finite = np.ones(len(hits), dtype=bool)
    for field in ("x", "y", "z", "Q"):
        finite &= np.isfinite(hits[field])
    renderable = hits[finite]
    inside = np.zeros(len(renderable), dtype=bool)
    for box in boxes.values():
        inside |= box.contains(renderable["x"], renderable["y"], renderable["z"])
    q = hits["Q"].astype(float)
    q_finite = q[np.isfinite(q)]
    signed_q = float(q_finite.sum())
    if not np.isfinite(signed_q):
        signed_q = None
    # Plotting cap is independent of event selection. Never rank/subselect by Q.
    plotted = renderable
    if len(plotted) > max_hits:
        take = np.sort(np.random.default_rng(seed).choice(len(plotted), max_hits, replace=False))
        plotted = plotted[take]
    colors = plotted["Q"].astype(float)
    positive = colors > 0
    floor = float(colors[positive].min()) if np.any(positive) else 1.0
    logq = np.log10(np.where(positive, colors, floor))
    lo = float(logq.min()) if len(logq) else 0.0
    hi = float(logq.max()) if len(logq) else 1.0
    if hi <= lo:
        lo, hi = lo - 0.5, hi + 0.5
    return dict(
        schema=SCHEMA, event_index=int(index), event_id=str(event_id),
        summary=dict(raw_hits=len(hits), renderable_hits=len(renderable), plotted_hits=len(plotted),
                     omitted_nonfinite=int((~finite).sum()),
                     outside_nominal=int((~inside).sum()), sampled_hits=len(plotted) < len(renderable),
                     finite_Q_sum=signed_q, nonfinite_Q=int((~np.isfinite(q)).sum())),
        hits={key: plotted[key].astype(float).tolist() for key in ("x", "y", "z", "Q")},
        color=dict(label="log10(Q), input units", values=logq.tolist(), minimum=lo, maximum=hi),
    )


def build(path: Path, cache: Path, options: Sampling, completion: str, *, reader_factory=None,
          boxes_factory=None, final_check=lambda: None):
    """Caller holds cache writer lock and has established completion evidence."""
    start = time.monotonic()
    before = stamp(path)
    key = source_key(before, options)
    if reader_factory is None or boxes_factory is None:
        reader_factory, boxes_factory = upstream()
    boxes = boxes_factory()
    seed_material = json.dumps(dict(source=before, seed=options.seed, hit_type=options.hit_type), sort_keys=True)
    rng_seed = int(hashlib.sha256(seed_material.encode()).hexdigest()[:16], 16)
    with reader_factory(path, options.hit_type, options.block_rows) as reader:
        indices = sample_indices(len(reader), options.sample_size, rng_seed)
        catalog = dict(
            source_key=key,
            source={"name": path.name, "size_bytes": before["size"],
                    "mtime": before["mtime_ns"] / 1e9},
            total_events=len(reader), hit_type=options.hit_type,
            selection={"type": "random", "uniform": True, "includes_empty_events": True,
                       "requested": options.sample_size, "seed": str(rng_seed)},
            sampling=asdict(options), cleaning="none", completion=completion,
            geometry=geometry_payload(boxes), demo=False,
            provenance={"app_version": __version__, "reader_commit": UPSTREAM_COMMIT},
        )
        # Sample order is random; read indices in increasing order for read-ahead locality.
        # Retain at most sample_size capped event payloads, not the full hit table.
        payloads = {}
        for index in sorted(indices):
            payloads[index] = event_payload(reader.get(index), index, reader.event_id(index),
                                            boxes, options.max_hits, rng_seed ^ index)
        catalog["build_seconds_before_publish"] = round(time.monotonic() - start, 3)

        def unchanged():
            reader.check_unchanged()
            if stamp(path) != before:
                raise RuntimeError("FLOW changed during sampling; nothing published")
            final_check()

        manifest = publish(cache, catalog, (payloads[i] for i in indices), final_check=unchanged)
    return manifest
