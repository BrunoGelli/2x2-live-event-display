# Architecture and data contract

## Separation of responsibilities

`producer.py` imports the pinned upstream `EventHitReader` and `module_boxes_cm`.
`ref_region` describes slices of **reference pairs**, not calibrated-hit rows; the
upstream reader resolves the target indices. Tests include shuffled/sparse references
and an empty event. There is no duplicated production FLOW parser or detector geometry.

The only selector is uniform random sampling without replacement over all event rows.
The seed derives from the source stamp, configured seed and hit collection. File identity
and cache compatibility also include sampling options and pinned reader/app versions.
Changing the plot cap does not change which event rows are sampled. Source paths are
hashed privately for identity; public metadata contains basenames, never absolute paths.

No charge, light, beam, hit-count, geometry or noise criterion selects events. The
MVP also applies no hot-pixel cleaning. This deliberately exposes raw detector activity.
Future selectors/cleaning must be explicit, versioned and accompanied by diagnostics.

## Cache layout

```
cache/
  .writer.lock              # fixed-inode advisory writer lock; never served
  worker.json               # public-safe heartbeat and error code
  latest.json               # complete small catalog, atomically replaced
  generations/<32-hex-id>/
    catalog.json
    event-<event-index>.json
```

Each generation is immutable. JSON is UTF-8 with finite numbers or null, never NaN.
Event IDs are strings so browser integer precision cannot silently alter them.
Coordinates are stored in detector `(x,y,z)` centimetres; the frontend uses Plotly
axes `(z,x,y)` to keep physical y vertical. Nominal geometry and frame bounds travel
in the catalog. Positive-Q log colors and bounds travel with every event as plain
numeric arrays; finite nonpositive Q maps to the lowest positive plotted-Q color.

The event summary includes all raw-hit counts, sum of finite Q, nonfinite omissions,
finite out-of-volume counts and plotting-cap counts. These are diagnostics, not physics
selections. A maximum 20,000 finite hits/event is published by default. Whole events
are read before subsampling; pathological huge events remain a worker-memory risk.

## Publication and failure behavior

A writer builds a hidden staging directory, validates the source/ready marker, renames
the completed generation, then atomically replaces latest.json. Old generations survive
failure. Watch mode retries failed files with a bounded delay and skips historical
backlog. A lock prevents competing producers for the same cache.

Retention removes only schema-marked old generation directories with matching IDs,
keeping at least the latest 12 and a one-hour grace period. It never deletes source FLOW.
A very old paused browser can outlive retention; an expired event returns 404 and the
viewer keeps its current image, polls latest and recovers at an event boundary.

"Latest" is explicitly file **mtime ordering**. Reprocessing/backfilling an old run
can update mtime; constrain the watched run directory until a validated acquisition-time
ordering is available. Stability fallback is heuristic, not an authoritative finish flag.

## Read-only API

- GET `/api/status`: no-store freshness/heartbeat summary.
- GET `/api/catalog`: no-store latest generation and sampled event indices.
- GET `/api/generations/{generation}/events/{index}`: immutable cached event JSON;
  index must belong to that generation's catalog.
- GET `/healthz` and `/readyz`: service and cache readiness.

No path query, directory listing, HDF5 reader, pickle loader, upload, code execution,
network fetch or mutation endpoint exists in the public web app. CORS is not enabled.
Only frontend assets are statically mounted. Public cache access is an explicit allowlist.
Only trusted operators can write the cache; filesystem permissions are the trust boundary.

## Browser lifecycle

One reused 3D Plotly scene. The next event is prefetched, with at most three event
payload promises retained. Catalog IDs pin requests to a consistent generation. New
catalogs wait for the next event boundary; paused cycling does not silently switch files.
Fetch errors preserve the visible event. A zero-event file displays an explicit state.

Camera motion uses requestAnimationFrame and a single in-flight Plotly.relayout.
No frame-by-frame HTTP/WebSocket traffic. Drag/zoom pauses rotation for inspection.
Cycling and rotation are separate controls; changing either requires no worker action.
The event dwell is measured after loading/rendering, so actual loop time includes overhead.

## Deliberately absent

No beam/light association guesses; no masks built over the full file; no public raw-file
serving; no automatic public deployment; no claimed DAQ-real-time latency; no physics
classification or alarm semantics; no indefinite scheduler renewal.

## Viewer transition update

Pending navigation no longer blocks the camera. Only the actual Plotly 3D commit is
exclusive with camera updates, and visible catalog/event state is committed afterward.
Projections have an independent bounded latest-only queue. Event HTTP requests honor
the server's immutable caching contract; status and catalog remain uncached.

Production format remains **FLOW → sampled JSON → viewer**. There is no intermediate
`.FLOW.ED.h5` writer or reader. A future nearline adapter should reuse this JSON contract
and preserve one serialized latest publisher rather than introducing parallel writes
to the shared `latest.json`. Historical tests use sequential `once` publications in a
dedicated cache, not a change to `watch`'s newest-only behavior.
