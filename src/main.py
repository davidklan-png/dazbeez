"""
Dazbeez — company homepage
"""
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

STATIC_DIR = Path(__file__).parent.parent / "static"


class HealthResponse(BaseModel):
    status: str
    timestamp: str


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="Dazbeez", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status="ok",
        timestamp=datetime.now(timezone.utc).isoformat(),
    )


@app.get("/", response_class=HTMLResponse)
async def homepage():
    return (STATIC_DIR / "index.html").read_text()
