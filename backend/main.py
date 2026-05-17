"""FastAPI entry point. Run via:

    source .venv/bin/activate
    uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload

In Docker, this is the `datacaster-backend` service. The frontend is served
by `datacaster-frontend` (nginx) which proxies /api/* back here.
"""

# bootstrap MUST be the first import
from . import bootstrap  # noqa: F401

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import db, pipeline, sandbox as sandbox_mod
from .classifier import tail_jsonl_forever
from .commentary import commentary_worker
from .highlights import highlight_indexer
from .routes import ask as ask_routes
from .routes import commentary as commentary_routes
from .routes import events as events_routes
from .routes import export as export_routes
from .routes import highlights as highlights_routes
from .routes import lifecycle as lifecycle_routes
from .routes import search as search_routes

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init()
    # Sweep sidecar-tracked sandboxes from prior crashes (never touches other accounts).
    try:
        stopped = await sandbox_mod.sweep_orphans()
        if stopped:
            log.info("startup sweep: stopped %d orphan sandbox(es)", stopped)
    except Exception as e:  # noqa: BLE001
        log.warning("startup sandbox sweep failed: %s", e)

    stop = asyncio.Event()
    tasks: set[asyncio.Task] = set()
    tasks.add(asyncio.create_task(tail_jsonl_forever(stop), name="jsonl_tailer"))
    tasks.add(asyncio.create_task(commentary_worker(stop), name="commentary_worker"))
    tasks.add(asyncio.create_task(highlight_indexer(stop), name="highlight_indexer"))
    log.info("background workers up: %s", [t.get_name() for t in tasks])
    try:
        yield
    finally:
        log.info("shutdown: cancelling workers")
        stop.set()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        # Critical: release sandbox so a running session doesn't leak medium-tier billing.
        if (pipeline.state.sandbox is not None
                or pipeline.state.rtstream is not None
                or pipeline.state.video is not None):
            log.info("shutdown: stopping active pipeline + sandbox")
            try:
                await pipeline.stop_pipeline()
            except Exception as e:  # noqa: BLE001
                log.warning("shutdown stop_pipeline failed: %s", e)


app = FastAPI(title="DataCaster", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"], allow_headers=["*"], allow_credentials=True,
)
app.include_router(lifecycle_routes.router)
app.include_router(events_routes.router)
app.include_router(search_routes.router)
app.include_router(commentary_routes.router)
app.include_router(highlights_routes.router)
app.include_router(ask_routes.router)
app.include_router(export_routes.router)


# Backend is API-only; frontend proxies /api/* via nginx (docker) / Vite (dev).
@app.get("/")
async def root():
    return {"app": "DataCaster", "ok": True}
