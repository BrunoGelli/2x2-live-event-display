# Validation

Run the worker/HTTP regression tests after installing `.[worker,dev]`:

```bash
pytest -q
python -m compileall -q src tests
node --check src/live2x2/static/app.js
```

Tests cover random reproducibility, empty file/event handling, sparse/shuffled FLOW
references, selected-only reads, no source writes, invalid rendering values, Q retention,
plot-cap/event-selection separation, failed atomic publication, single-writer locking,
ready markers, changed-file stability timing, retry behavior, restart deduplication,
newest-ready selection, generation-pinned HTTP reads, absent mutation/path APIs,
cache-unavailable/stale states and reverse-proxy-prefixed routes.

For a browser smoke test, publish synthetic demo data and run the server, then:

```bash
python -m pip install playwright
python -m playwright install chromium
python scripts/browser_smoke.py --url http://127.0.0.1:8000/
```

This test must use a **demo cache**, not a changing production stream. It checks
rendered WebGL availability, Q color vectors, camera motion, paused cycling and event
navigation. In an environment without WebGL, it fails explicitly instead of calling
changes to camera data a visual rendering test.

During initial implementation, local tests used the reviewed upstream reader/geometry
implementation with synthetic HDF5 fixtures. Browser control/Plotly camera-state tests
ran against the real frontend through an in-memory HTTP adapter because this sandbox
blocks localhost navigation. The sandbox browser could not render WebGL, so those tests
do **not** certify 3D rendering performance. Full pinned-package installation, the
NERSC proxy, actual CFS throughput, Docker build and Spin rollout require the staged
smoke tests on their real platforms. No production detector data is included in tests.

## Viewer follow-up regression tests

`node --test tests/test_viewer.cjs` runs the actual frontend source with deterministic
asynchronous fetch/Plotly substitutes. It verifies rotation during delayed fetches,
mutual exclusion during the 3D commit, pause-during-fetch behavior, generation/metadata
consistency, latest-only projection updates, failed-fetch recovery, immutable-request
caching and zero-event file handling. The delayed-fetch test fails on the original MVP
source. These concurrency tests do not measure real GPU performance.

`tests/test_assets.py` verifies atomic full-content asset validation and strict-asset
readiness/CSP behavior. The browser CI job downloads the actual pinned strict bundle
and exercises the real HTTP/WebGL viewer on synthetic data. For the same full smoke test
locally, provide a dedicated demo cache:

```bash
python scripts/browser_smoke.py --url http://127.0.0.1:8000/ --cache ./demo-cache
```

See [viewer/rollover test](VIEWER_TEST.md) for a safe manual test on older completed FLOW
files without copying them or changing mtimes. Neither the frontend changes nor the
smoke tests implement any nearline scheduling integration or reduced-HDF5 product.
