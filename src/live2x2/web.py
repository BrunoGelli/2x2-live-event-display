"""Read-only HTTP layer. No HDF5, filesystem path API, background scanner or Panel."""
from __future__ import annotations

import logging
import os
from pathlib import Path
import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .cache import GENERATION, SCHEMA, latest, read_json

STATIC = Path(__file__).parent / "static"
PLOTLY_ASSET = "vendor/plotly-strict.min.js"
LOG = logging.getLogger(__name__)


def create_app(cache_dir=None, *, stale_seconds=600.0, heartbeat_seconds=120.0, root_path=""):
    cache = Path(cache_dir or os.environ.get("LIVE2X2_CACHE", "./cache")).resolve()
    stale_seconds = float(os.environ.get("LIVE2X2_STALE_SECONDS", stale_seconds))
    heartbeat_seconds = float(os.environ.get("LIVE2X2_HEARTBEAT_SECONDS", heartbeat_seconds))
    if stale_seconds <= 0 or heartbeat_seconds <= 0:
        raise ValueError("Freshness thresholds must be positive")
    app = FastAPI(title="2x2 nearline display", docs_url=None, redoc_url=None,
                  openapi_url=None, root_path=root_path)
    app.add_middleware(GZipMiddleware, minimum_size=1000)

    @app.middleware("http")
    async def headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; "
            "object-src 'none'; base-uri 'self'"
        )
        return response

    def manifest(generation=None):
        try:
            if generation is None:
                data = latest(cache)
                if data is None:
                    raise HTTPException(503, "No completed file published yet")
                return data
            if not GENERATION.fullmatch(generation):
                raise HTTPException(404, "Unknown generation")
            folder = cache / "generations" / generation
            if folder.is_symlink():
                raise HTTPException(404, "Unknown generation")
            data = read_json(folder / "catalog.json")
            if data.get("schema") != SCHEMA or data.get("generation") != generation:
                raise ValueError("Generation catalog mismatch")
            return data
        except FileNotFoundError:
            raise HTTPException(404, "Generation expired; refresh latest catalog")
        except (OSError, ValueError):
            LOG.exception("Cannot read catalog")
            raise HTTPException(503, "Cache temporarily unavailable")

    @app.get("/")
    def index():
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/healthz")
    def health():
        return {"service": "ok"}

    @app.get("/readyz")
    def ready():
        manifest()
        if not (STATIC / PLOTLY_ASSET).is_file():
            raise HTTPException(503, "Plotly asset not installed")
        return {"cache": "available"}

    @app.get("/api/catalog")
    def catalog():
        return JSONResponse(manifest(), headers={"Cache-Control": "no-store"})

    @app.get("/api/generations/{generation}/events/{index}")
    def event(generation: str, index: int):
        data = manifest(generation)
        if index not in {row["event_index"] for row in data["events"]}:
            raise HTTPException(404, "Event is not in this sampled generation")
        path = cache / "generations" / generation / f"event-{index}.json"
        if path.is_symlink() or not path.is_file():
            raise HTTPException(404, "Event unavailable; refresh catalog")
        return FileResponse(path, media_type="application/json", headers={
            "Cache-Control": "public, max-age=3600, immutable"})

    @app.get("/api/status")
    def status():
        now = time.time()
        try:
            data = latest(cache)
            worker = read_json(cache / "worker.json") if (cache / "worker.json").is_file() else None
        except (OSError, ValueError):
            LOG.exception("Cannot read status")
            return JSONResponse({"state": "CACHE_ERROR", "server_time": now}, status_code=503,
                                headers={"Cache-Control": "no-store"})
        file_age = max(0, now - data["source"]["mtime"]) if data else None
        heartbeat_age = max(0, now - worker["updated_at"]) if worker else None
        state = "WAITING" if not data else ("DEMO" if data.get("demo") else
                                          "STALE" if file_age > stale_seconds else "CURRENT")
        response = dict(state=state, server_time=now, generation=data["generation"] if data else None,
                        source=data["source"] if data else None, file_age_seconds=file_age,
                        cache_age_seconds=max(0, now-data["published_at"]) if data else None,
                        stale_after_seconds=stale_seconds, worker=worker,
                        heartbeat_age_seconds=heartbeat_age,
                        worker_stale=heartbeat_age is None or heartbeat_age > heartbeat_seconds)
        return JSONResponse(response, headers={"Cache-Control": "no-store"})

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app
