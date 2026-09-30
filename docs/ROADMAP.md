# Acceptance gates and later work

## Gate 1 — random sampling on one completed FLOW (this MVP)

Verify references, event IDs, empty/noisy events, signed Q, colour range, coordinate
orientation, display-cap warning and original-file checksum/mtime unchanged. Confirm
same file/settings gives the same sample; only selected events are read.

## Gate 2 — continuous cache producer (this MVP)

Agree the nearline completion signal; never substitute an unqualified "HDF5 opens" test.
Observe two real file transitions, failed/incomplete input, retry, restart, stale input,
worker exit and a paused viewer. Measure build time and memory on representative files.
The 3-minute cadence is a target, not a measured guarantee.

## Gate 3 — public NERSC service (deployment scaffolding supplied)

Validate the Spin image, namespace, readonly dedicated CFS mount, UID/GID, HTTPS,
readiness/liveness, recovery after worker/service restarts and access from a shifter
browser. Do not mistake the Jupyter development route for a public service.

## Later, only after the above

- Add explicit beam/spill and light selectors after checking real Run-3 association fields.
- Add high-activity/noise selectors using shared, versioned cleaning and diagnostics.
- Add event-local/global mask overlays with raw comparison; keep random membership unbiased.
- Evaluate source acquisition timestamps, quality flags, stored-coordinate/t0 diagnostics.
- Add run-config discovery, monitoring integration, service load limits and measured SLOs.

Do not introduce a big framework or speculative detector mappings in order to scaffold
future selectors. Keep their future catalog/API representation explicit and additive.
