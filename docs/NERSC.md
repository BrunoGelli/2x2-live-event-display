# NERSC runbook: prove each stage before the next

## 1. Installation (login node, internet access)

```bash
module load python
conda create -n live2x2 python=3.11 pip -y
conda activate live2x2
cd ~/2x2-live-event-display
python -m pip install -e '.[worker,dev]'
live2x2 assets
pytest -q
```

The pinned upstream git dependency deliberately does not track `main` or an editable
checkout. Updating it is a separate tested change. No site/user files are installed
or changed beyond the chosen environment, repo assets and explicit cache path.

## 2. Produce one sample on a compute node

```bash
salloc -A dune -q interactive -C cpu -N 1 -t 01:00:00
```

Use the allocated compute-node shell (check `hostname`). Activate `live2x2` there:

```bash
conda activate live2x2
CACHE="$PSCRATCH/live2x2-cache"
FILE="/global/cfs/cdirs/dune/www/data/2x2/nearline_run3/flowed_charge/ColdCommissioning/20260928_Cosmic/packet-0070002-2026_09_28_19_33_16_CDT.FLOW.hdf5"
live2x2 once "$FILE" --assume-complete --cache "$CACHE" --sample-size 60
```

That filename is a previously used completed-file example, not an assumed current
latest file. Substitute the file being tested. No PKL or 14 GB copy is needed.
The producer reads ref metadata plus selected hit ranges, not all events or unrelated
light/truth tables. One exceptionally large event can still consume substantial
memory before the plotting cap; measure on real data before setting resource limits.

## 3. Serve inside Jupyter for commissioning

From **Jupyter's Terminal**, not a random SSH login node:

```bash
conda activate live2x2
CACHE="$PSCRATCH/live2x2-cache"
live2x2 serve --cache "$CACHE" --jupyter --port 8000
```

Keep this process running. It binds loopback and prints the authenticated proxy URL.
Use another free port if necessary. Relative asset/API paths allow the stripped-prefix
proxy route; the printed URL must end in `/`. `--root-path` is also available for
other correctly configured reverse proxies. No `--allow-websocket-origin` is needed:
this app uses HTTP requests, not camera-update WebSockets.

Confirm random selection, empty events, Q colors, rotation, pause/next/previous and
projections. On a paused viewer, publish another file and confirm it remains paused
until Next/Resume/Show newer file. Check metadata identifies the actual displayed
file. View the browser console if WebGL is unavailable or rendering fails.

## 4. Observe completed files

Set `FLOW_DIR` to a **bounded current run directory**, rather than scanning years of
CFS recursively every 15 seconds. The default glob is case-sensitive `*.FLOW.hdf5`.
Use `--pattern '*.FLOW.h5'` if that is the actual extension.

Preferred integration: call `live2x2 once ... --assume-complete` at the successful end
of the nearline FLOW job, after all HDF5 handles have closed. Do not run a second writer
at the same time. For polling, use `.done` markers produced only after completion:

```bash
live2x2 watch --directory "$FLOW_DIR" --cache "$CACHE" --recursive \
    --completion marker --sample-size 60 --max-hits 20000 --poll-seconds 15
```

The marker convention is proposed, **not already wired into CRS nearline**. Until it
is agreed, `--completion stable --stable-seconds 120` is an explicitly heuristic
alternative. It introduces at least the stability wait plus polling/build latency.
For production, prefer an authoritative completion signal.

A finite shared CPU job is supplied:

```bash
export LIVE2X2_PYTHON="$(python -c 'import sys; print(sys.executable)')"
sbatch -A dune deploy/watch.slurm --directory "$FLOW_DIR" --cache "$CACHE" \
    --recursive --completion marker
```

The job exits at its Slurm wall time; nothing here arranges indefinite renewals.
A successful-output hook in the existing nearline allocation is preferable to keeping
an exclusive CPU node allocated just to poll. Restarting the watcher preserves the
current cache and avoids rebuilding an unchanged file/configuration.

Error logs include full local paths in the worker terminal/Slurm log. Public status
only contains a bounded error code and candidate basename. Failed builds are retried
after 60 seconds and never discard the last published sample.

## 5. Public Spin deployment (separate acceptance gate)

The repository supplies a **web-only** container and a parameterized Kubernetes
example. These are not an already deployed service or a claim of a reserved DNS name.

Spin can mount `/global/cfs`, but not Perlmutter `$PSCRATCH` as an NGF mount. Use a
project-owned, dedicated CFS cache directory for the production worker and web service.
Mount **only that cache directory**, read-only, at `/cache` in the web container.
Set the container's numeric NERSC UID, primary GID and filesystem group appropriately.
Do not recursively chmod/chown the source data tree.

Build off the compute node with your supported container tool:

```bash
docker build -t YOUR_REGISTRY/2x2-live-display:TESTED_COMMIT .
# Push explicitly using your registry's authenticated workflow.
```

Use `deploy/spin.yaml.in` as a template: replace `NAMESPACE`, `IMAGE`, `NERSC_UID`,
`NERSC_GID`, `CACHE_PATH`, `HOST`, `TLS_SECRET` and `INGRESS_CLASS`, then review the
expanded file before applying it. Namespace membership, registry push, CFS access,
custom DNS and TLS certificate provisioning remain NERSC/project administration steps.
Do not publish an unencrypted production URL.

The container listens on 8000. Readiness checks `/readyz` (cache + JS asset present);
liveness checks `/healthz` (HTTP process). A stale feed stays available with a visible
warning; it should not trigger a restart loop that erases useful last-known data.
The app has no authenticated controls because every endpoint is read-only, and the
user has approved public exposure of these derived displays. Protect the ingress with
appropriate platform request/rate limits before wider use.

## Operational checks

`/api/status` reports source mtime age, cache publication age and worker heartbeat
separately. CURRENT means recent FLOW according to the configured mtime threshold,
not that the detector itself is healthy. Default stale threshold: 600 s; heartbeat
threshold: 120 s. Environment overrides: `LIVE2X2_STALE_SECONDS` and
`LIVE2X2_HEARTBEAT_SECONDS`. A one-shot producer naturally stops emitting heartbeats.

Workers use an advisory filesystem lock, atomic rename on the cache filesystem and
normal project-readable derived files. Confirm locking/rename/permissions on the
actual CFS deployment. Never disable HDF5 file locking to force-read in-progress files.

## Official platform references

- https://docs.nersc.gov/jobs/interactive/
- https://docs.nersc.gov/services/jupyter/reference/
- https://docs.nersc.gov/services/spin/storage/
- https://docs.nersc.gov/services/spin/connecting/
- https://fastapi.tiangolo.com/advanced/behind-a-proxy/
- https://plotly.com/javascript/plotlyjs-function-reference/
