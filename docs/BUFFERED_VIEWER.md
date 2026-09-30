# Pre-rendered event handover

This frontend update does not change random selection, FLOW reading, JSON schema,
watch/once behavior, hit caps, geometry, projections, security policy or deployment.
The original analysis and nearline repositories are unchanged.

## Why another rendering change

The previous two-phase navigation removed the deliberate freeze during HTTP fetch.
It still updated the complete foreground Plotly scene at the event boundary. A real
Chromium/SwiftShader benchmark with Plotly strict 4.1.1 and 20,000 synthetic points
found that simply replacing `react` with hit-only `restyle` did not remove that cost.
The first four measured full-react updates were 151.4, 116.2, 116.2 and 114.5 ms;
stable-layout react was 103.8, 103.5, 108.5 and 113.0 ms; restyle was 139.0, 115.5,
102.8 and 105.1 ms. These are software-rendered CI measurements, not NERSC/browser
performance claims. See transition-benchmark run 36775806084, job 110093278907.

## What changed

Exactly two reusable 3D Plotly scenes are kept: one visible and one prepared behind
it. The next sampled event is fetched and rendered into the back scene before the
next normal event deadline. A ready handover synchronizes that scene to the current
camera and swaps visibility; it does not replot its point arrays. The old scene
becomes the next back buffer. There is no per-event accumulation of WebGL contexts,
no crossfade or interpolation between unrelated detector events, and no automatic
reduction of hit count to hide the lag.

The back scene remains fully sized (opacity zero, not display:none) while preparing.
It is inaccessible to pointers, focus and assistive technology until promoted.
Manual rotation/zoom and the latest camera pose are carried into the new scene.
Pause during an automatic fetch or camera handover cancels promotion. Manual Next
continues to work. Preparation failures keep the old event and metadata visible.
Newer-file catalogs remain queued. Projections retain the strict-bundle WebGL renderer
and their independent latest-request-only update queue.

This is **pre-rendering, not off-main-thread rendering**. The computation/GPU upload
has been moved out of the ready handover, not eliminated. Large events can still
cause a brief main-thread hitch during preparation. A second live scene also uses
additional bounded GPU memory. User-browser performance must be checked before
calling the transition issue resolved. The first event and an unprepared manual
Previous may require on-demand preparation while the old event remains visible.

## Upgrade and test

Stop/restart only the viewer; the existing JSON cache remains compatible:

```bash
cd ~/2x2-live-event-display
conda activate live2x2
git pull --ff-only
live2x2 serve --cache "$CACHE" --jupyter --port 8000
```

Use the port and cache from your current test. Hard-refresh the browser. No new
`live2x2 assets` download is needed if the previous strict bundle is already installed.
No masks, FLOW copies, reduced HDF5 or cache regeneration are required.

Under File and display details, look for:

- Transition mode: Two-scene pre-rendered handover.
- Next scene ready at navigation: Yes for normal timed cycling after warmup.
- Fetch, preparation, camera-settle and handover timings listed separately.

Test several timed transitions, manual Previous/Next, rotation/zoom while paused,
projections open, window resizing, and the historical-file replay already used.
Keep source-file ages honest; historical data still correctly shows STALE.

## Regression and measurement tools

`node --test tests/test_viewer.cjs` tests actual frontend control flow with deterministic
IO/Plotly substitutes, including preparation errors, queued newer catalogs, manual
navigation conflicts, pause during handover, no foreground data redraw and reuse of
exactly two graph nodes. Those tests do not measure WebGL rendering speed.

The real HTTP/CSP browser smoke remains in `scripts/browser_smoke.py`.
`benchmark_transitions.py` compares Plotly update paths; `benchmark_buffered.py`
checks ready handovers on dense synthetic payloads and logs preparation/handover
measurements. Run only against a dedicated demo server, not a production feed.

```bash
python scripts/benchmark_transitions.py --points 20000 --repeats 4
python scripts/benchmark_buffered.py --points 20000 --transitions 6
```

The next integration stage remains FLOW -> JSON produced by watch/once or future
nearline jobs -> separate `live2x2 serve`. This update does not deploy Spin or change
nearline job scheduling.
