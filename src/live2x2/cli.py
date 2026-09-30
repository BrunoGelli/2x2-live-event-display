"""Small staged CLI: assets, demo, once, watch, serve. Web is always read-only."""
from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path
import signal
import threading
from urllib.parse import urlsplit
import urllib.request

from .cache import heartbeat, writer_lock


def parser():
    p = argparse.ArgumentParser(prog="live2x2")
    sub = p.add_subparsers(dest="command", required=True)
    assets = sub.add_parser("assets", help="Install pinned Plotly.js (once, with internet access)")
    assets.add_argument("--from-file", type=Path, help="Offline copy of official plotly-4.1.1.min.js")
    demo = sub.add_parser("demo", help="Publish clearly labelled synthetic events")
    demo.add_argument("--cache", type=Path, required=True)
    demo.add_argument("--events", type=int, default=60)
    for name in ("once", "watch"):
        t = sub.add_parser(name)
        t.add_argument("--cache", type=Path, required=True)
        t.add_argument("--sample-size", type=int, default=60)
        t.add_argument("--max-hits", type=int, default=20000)
        t.add_argument("--seed", type=int, default=0)
        t.add_argument("--hit-type", choices=["prompt", "final"], default="prompt")
        t.add_argument("--block-rows", type=int, default=16384)
        if name == "once":
            t.add_argument("file", type=Path)
            t.add_argument("--assume-complete", action="store_true", required=True,
                           help="Assert that the FLOW producer has finished/closed this file")
        else:
            t.add_argument("--directory", type=Path, required=True)
            t.add_argument("--pattern", default="*.FLOW.hdf5")
            t.add_argument("--recursive", action="store_true")
            t.add_argument("--completion", choices=["marker", "stable"], default="marker")
            t.add_argument("--marker-suffix", default=".done")
            t.add_argument("--stable-seconds", type=float, default=120)
            t.add_argument("--poll-seconds", type=float, default=15)
    s = sub.add_parser("serve")
    s.add_argument("--cache", type=Path, required=True)
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    s.add_argument("--jupyter", action="store_true")
    s.add_argument("--hub-url", default="https://jupyter.nersc.gov")
    s.add_argument("--root-path", default="")
    s.add_argument("--stale-seconds", type=float, default=600)
    return p


def install_assets(source=None):
    from .web import STATIC
    dest = STATIC / "vendor/plotly.min.js"
    if source:
        data = source.read_bytes()
    else:
        with urllib.request.urlopen("https://cdn.plot.ly/plotly-4.1.1.min.js", timeout=60) as response:
            data = response.read(15000001)
    if not 100000 < len(data) <= 15000000 or b"plotly.js v4.1.1" not in data[:200]:
        raise ValueError("Expected the official Plotly.js v4.1.1 bundle")
    data.decode("utf-8")  # Reject corrupted source rather than quietly replacing bytes.
    dest.parent.mkdir(parents=True, exist_ok=True)
    import tempfile
    fd, tmp = tempfile.mkstemp(dir=dest.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    print(f"Installed Plotly.js 4.1.1: {dest}")


def main(argv=None):
    p = parser()
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        if args.command == "assets":
            install_assets(args.from_file)
            return 0
        args.cache = args.cache.expanduser().resolve()
        if args.command == "serve":
            from .web import create_app, STATIC
            import uvicorn
            if not (STATIC / "vendor/plotly.min.js").is_file():
                raise ValueError("Run 'live2x2 assets' once before starting the viewer")
            if not 1 <= args.port <= 65535:
                raise ValueError("Port must be 1..65535")
            root = args.root_path.rstrip("/")
            if args.jupyter:
                prefix = os.environ.get("JUPYTERHUB_SERVICE_PREFIX", "")
                hub = urlsplit(args.hub_url)
                if not prefix.startswith("/") or hub.scheme not in ("http", "https") or not hub.netloc:
                    raise ValueError("Use --jupyter inside the running Jupyter server terminal")
                args.host = "127.0.0.1"
                root = prefix.rstrip("/") + f"/proxy/{args.port}"
                print(f"Open: {args.hub_url.rstrip('/')}{root}/", flush=True)
            else:
                print(f"Viewer: http://{args.host}:{args.port}{root}/", flush=True)
            uvicorn.run(create_app(args.cache, stale_seconds=args.stale_seconds),
                        host=args.host, port=args.port, root_path=root, proxy_headers=False)
            return 0
        if args.command == "demo":
            from .demo import generate
            if not 1 <= args.events <= 1000:
                raise ValueError("events must be 1..1000")
            with writer_lock(args.cache):
                result = generate(args.cache, args.events)
            print(f"Published DEMO generation {result['generation']}")
            return 0
        from .producer import Sampling, build
        options = Sampling(args.sample_size, args.max_hits, args.seed, args.hit_type, args.block_rows)
        with writer_lock(args.cache):
            if args.command == "once":
                heartbeat(args.cache, "building", candidate=args.file.name)
                try:
                    result = build(args.file.expanduser().resolve(), args.cache, options, "operator_asserted")
                except Exception:
                    heartbeat(args.cache, "error", error_code="publish_failed", candidate=args.file.name)
                    raise
                heartbeat(args.cache, "idle", candidate=args.file.name)
                print(f"Published {result['sampled_events']} random events: {result['generation']}")
                return 0
            from .watcher import Watcher
            if not 1 <= args.poll_seconds <= 300:
                raise ValueError("poll-seconds must be 1..300")
            watcher = Watcher(args.directory.expanduser(), args.cache, options,
                              pattern=args.pattern, recursive=args.recursive,
                              completion=args.completion, marker_suffix=args.marker_suffix,
                              stable_seconds=args.stable_seconds)
            if args.completion == "stable":
                logging.warning("Size/mtime stability is heuristic: a paused writer may still be incomplete")
            stop = threading.Event()
            signal.signal(signal.SIGTERM, lambda *_: stop.set())
            signal.signal(signal.SIGINT, lambda *_: stop.set())
            try:
                while not stop.is_set():
                    try:
                        watcher.tick()
                    except Exception:
                        logging.exception("Watcher scan failed; retaining last good cache")
                        heartbeat(args.cache, "error", error_code="scan_failed")
                    stop.wait(args.poll_seconds)
            finally:
                heartbeat(args.cache, "stopped")
        return 0
    except (ValueError, RuntimeError, OSError, KeyError) as exc:
        p.error(str(exc))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
