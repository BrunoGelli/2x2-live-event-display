# Viewer update and historical-file rollover test

## Upgrade the viewer (same cache schema, same producer)

```bash
git pull --ff-only
live2x2 assets
```

Restart `live2x2 serve` and hard-refresh the browser. `assets` now installs the official
**strict Plotly.js 4.1.1** bundle at a new URL, validated against the full upstream Git
blob identity. Old standard-bundle assets are not loaded. No CSP relaxation, trace-type
fallback, new detector data or HDF5 layer is introduced. Both `scatter3d` and `scattergl`
remain in use. An offline install must supply `plotly-strict-4.1.1.min.js`.

The previous implementation paused the camera for the entire event-fetch operation.
Navigation now has two phases: fetching/preparing the next event while the current one
continues rotating, then an exclusive 3D commit after any camera update has settled.
Filename, event labels and file age continue describing the visible event until that
commit succeeds. Pausing cycling during a pending automatic fetch cancels that automatic
switch (manual Next still works). Another newer catalog arriving mid-fetch is retained.

Projection updates use a serialized, latest-request-only queue independently of the 3D
commit. Outdated projections are hidden while refreshing, rather than being mislabeled.
Projection failures do not reject a successfully displayed 3D event. Immutable event
requests now allow browser caching; latest/status requests still use `no-store`.

This removes an avoidable **wait-induced** pause, not all Plotly/WebGL rendering work.
There can still be a brief hitch while changing point buffers or parsing JSON on the
main thread. Last-transition fetch/camera-wait/3D-update timings appear in the existing
file/display details. No second scene, worker-thread renderer or trace-update redesign
is part of this change.

## Important: watch is latest-file mode, not archive replay

Pointing `live2x2 watch` at a directory of completed old files publishes the newest
eligible file, then waits. It intentionally does not visit every historical file.
The safest rollout test is to publish a short explicit list sequentially with `once`,
into a **dedicated replay cache**. Leave original files, mtimes and completion markers
alone. Do not run `watch` or another producer against that replay cache simultaneously.

In the allocated compute-node shell, choose a directory whose files are known complete:

```bash
conda activate live2x2
CACHE="$PSCRATCH/live2x2-replay"
FLOW_DIR="/global/cfs/cdirs/dune/path/to/completed/older/files"

# Start with three files, ordered by original mtime. Remove [:3] for a longer test.
python - "$FLOW_DIR" <<'PY' > replay_files.txt
from pathlib import Path
import sys
paths = sorted(
    (p for p in Path(sys.argv[1]).rglob('*.FLOW.hdf5') if p.is_file()),
    key=lambda p: (p.stat().st_mtime_ns, str(p)),
)
for path in paths[:3]:
    print(path.resolve())
PY
cat replay_files.txt

while IFS= read -r FILE; do
    [ -n "$FILE" ] || continue
    live2x2 once "$FILE" --assume-complete --cache "$CACHE" --sample-size 60 || break
    sleep 60
done < replay_files.txt
```

This produces only sampled-event JSON/catalogs. The 60-second pause is a test cadence,
not simulated acquisition time. Use 180 seconds to approximately view a full 60-event
playlist per file; fetching/rendering overhead makes the actual cycle a little longer.
The final cache remains viewable after the loop exits.

From a terminal inside the running NERSC Jupyter server:

```bash
conda activate live2x2
CACHE="$PSCRATCH/live2x2-replay"
live2x2 serve --cache "$CACHE" --jupyter --port 8001
```

Use the printed URL with its trailing slash. A separate port keeps an existing viewer
undisturbed. It is fine to start the server before the first publication; it will wait.

Check:

- A new catalog switches at an event boundary; filename and event ID update together.
- Paused cycling stays on the old file with a newer-file button until manual action/resume.
- The last file keeps cycling when the loop ends. An old source correctly shows STALE,
  even though its cache was just produced; do not alter timestamps to make it look live.
- Fetch failures keep the displayed file/labels, and projections never remain visible
  under the wrong event label. The old 3D event can continue rotating while data waits.

This exercises **publisher → JSON → HTTP → browser rollover**, not filesystem readiness
or MongoDB scheduling. `watch` readiness/arrival tests remain a separate acceptance gate.
Future nearline integration should generate the same JSON products, with per-source
immutable products and serialized latest publication; no `.FLOW.ED.h5` step is planned.

## Browser diagnostics

A WebGL test cube only establishes WebGL support on that page; it does not test our CSP
or Plotly's projection renderer. Reinstall the strict bundle before diagnosing a new
projection failure. Record browser console CSP/WebGL messages and check both plots at
once. Do not disable browser security or switch projections to SVG just to hide the
failure. `scripts/browser_smoke.py` tests the real HTTP headers, both WebGL plots, a
held event request, and optional demo-cache generation rollover.
