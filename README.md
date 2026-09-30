# 2x2 live event display

**A nearline event display for 2x2 Run 3 at NERSC, primarily for shifters monitoring detector status.**

This first release implements **random sampling only**. No beam/light classification,
activity ranking or noise selection is inferred. It samples up to 60 event rows from
the newest completed reconstructed FLOW file, including empty/noisy events, and
cycles through them at 3 seconds/event with independent browser-side rotation.

```
completed FLOW -> read-only Python producer -> atomic JSON cache -> FastAPI -> Plotly.js
```

The public web process never opens FLOW or pickle files. It serves only the compact,
precomputed cache. Camera motion and event timing happen in the browser, not through
Panel/WebSocket callbacks. The existing analysis repository remains unchanged.

## Start with one completed file

Use Python 3.11 or newer; a separate environment avoids disturbing the analysis GUI.
Run installation on a machine with internet access, before entering a compute job:

```bash
python -m pip install -e '.[worker,dev]'
live2x2 assets
```

`assets` downloads the pinned Plotly.js **strict 4.1.1** once. The browser then loads it from
this service, not a CDN. Offline install: `live2x2 assets --from-file plotly-strict-4.1.1.min.js`.
The worker extra pins the existing `ucd2x2` FLOW reader/geometry to commit
`0400d9b788d4515bee9a22b230df08937475d0ef`. It currently brings that package's declared
GUI dependencies into the **worker environment**, but the web-only install/container
has no dependency on it and does not import Panel, NumPy or HDF5.

In an allocated compute-node shell, use a file known to have finished:

```bash
CACHE="$PSCRATCH/live2x2-cache"
FILE="/global/cfs/cdirs/dune/path/to/completed.FLOW.hdf5"
live2x2 once "$FILE" --assume-complete --cache "$CACHE" --sample-size 60
```

In a **terminal inside the running NERSC Jupyter server**, activate the same environment
and set the same `CACHE` path, then:

```bash
live2x2 serve --cache "$CACHE" --jupyter --port 8000
```

Open the exact printed URL, including its final `/`. This is a development access
route, not the public deployment. No notebook or Panel server is needed.

For a local laptop, omit `--jupyter`, then open `http://127.0.0.1:8000/`.

## Test without detector data

```bash
live2x2 demo --cache ./demo-cache --events 60
live2x2 serve --cache ./demo-cache
```

Demo events and geometry are explicitly synthetic. Never use the demo cache as a
shifter detector feed. Do not mix demo and real cache directories.

## Follow new files

Preferred: the FLOW producer creates `filename.FLOW.hdf5.done` **after successfully
closing** the corresponding file. The watcher requires a marker at least as new as
that file, rechecks it before publication, and skips unready newer files.

```bash
live2x2 watch --directory "/global/cfs/cdirs/dune/path/to/flowed_charge" \
  --pattern '*.FLOW.hdf5' --recursive --cache "$CACHE" --completion marker
```

The current nearline's completion-marker convention is **not established here**.
Do not touch `.done` markers for files still being processed. As an explicit,
less-safe commissioning fallback:

```bash
live2x2 watch --directory "/global/cfs/cdirs/dune/path/to/flowed_charge" \
  --pattern '*.FLOW.hdf5' --recursive --cache "$CACHE" \
  --completion stable --stable-seconds 120
```

Stability means size/mtime unchanged across observations for that interval. It is
**not proof of completion**: a paused writer can satisfy it. Source changes while
sampling abort publication; HDF5-open alone is never accepted as readiness.

The watcher polls every 15 seconds, publishes only the newest ready file by
filesystem mtime, and intentionally skips backlog. The frontend swaps generations
at an event boundary, keeps looping the last sample if no file arrives, and does
not replace an event being inspected while cycling is paused.

## What the viewer shows

Independent event dwell/rotation controls; pause, next/previous; optional orthogonal
projections; current event index **and** stored event ID; raw/plotted counts; signed
sum of finite Q; file/cache ages; overdue worker heartbeat; CURRENT/STALE/OFFLINE
status. This is **nearline**: file mtime is not detector acquisition time.

No hot-pixel or physics cleaning is applied. Only nonfinite x/y/z/Q are omitted
from plotted arrays. A deterministic per-event hit cap (20,000 by default) bounds
browser payloads and is explicitly labelled. It does not change event membership.
The nominal detector frame can hide extreme coordinates visually; these hits still
contribute to counts and finite-charge summaries. Nonpositive Q uses the lowest
positive plotted-Q color; each event's log color range is explicit.

60 events x 3 seconds is roughly a three-minute loop, **plus fetching/rendering
time**. New-file cadence and rendering throughput are not guaranteed.

## Deployment and development

- [Viewer upgrade and safe old-file rollover test](docs/VIEWER_TEST.md).
- [NERSC staged runbook](docs/NERSC.md): one-file smoke test, watcher, public Spin service.
- [Architecture and cache contract](docs/ARCHITECTURE.md).
- [Roadmap and acceptance gates](docs/ROADMAP.md).
- [Validation instructions and limitations](docs/VALIDATION.md).

```bash
pytest -q
python -m compileall -q src
node --check src/live2x2/static/app.js
node --test tests/test_viewer.cjs
```

Source FLOW is opened read-only by the reused reader. Only one writer may own a
cache. Publication uses a staging directory and atomic `latest.json` replacement;
failed builds retain the last good generation. Historical generations have a
minimum one-hour grace period and retention floor to support paused viewers.

**Public deployment needs only the derived cache.** Mount it read-only in the web
container. Do not mount the full FLOW tree into the public server or put secrets
in the cache. There are no upload, shell-command or arbitrary-filesystem-path APIs.
