import argparse
import hmac
import logging
import os
import signal
import sys
import time
import asyncio
from contextlib import asynccontextmanager
from typing import List, Union

import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import uvicorn

logger = logging.getLogger("sidecar")

model = None
model_name_arg = None
device_name = None
dims = None
start_time = None
loaded = False
load_task = None


class EmbeddingRequest(BaseModel):
    input: Union[str, List[str]]
    model: str = ""


@asynccontextmanager
async def lifespan(app: FastAPI):
    global start_time
    start_time = time.time()
    global load_task
    loop = asyncio.get_event_loop()
    load_task = loop.run_in_executor(None, _load, model_name_arg, device_name)
    yield
    logger.info("Shutting down sidecar")


app = FastAPI(title="embedding-sidecar", lifespan=lifespan)

# Local-auth token delivered by SidecarManager on stdin as
# `SIDECAR_TOKEN=<token>` (never argv/env). None => standalone run,
# server stays unauthenticated (backward compatible).
_auth_token = None


@app.middleware("http")
async def _auth_middleware(request: Request, call_next):
    # Health stays open so manager polling is unchanged.
    if _auth_token is None or request.url.path == "/v1/health":
        return await call_next(request)
    received = request.headers.get("authorization", "")
    # compare_digest raises TypeError on non-ASCII (str) inputs: treat as
    # malformed credentials (401), never a 500.
    if not isinstance(received, str) or not received.isascii():
        received_valid = False
    else:
        received_valid = hmac.compare_digest(received, f"Bearer {_auth_token}")
    if not received_valid:
        return JSONResponse(
            status_code=401,
            content={
                "error": {
                    "message": "unauthorized",
                    "type": "auth_error",
                    "code": 401,
                }
            },
        )
    return await call_next(request)


MAX_TEXTS_PER_REQUEST = 100
# Matches EmbeddingClient.MAX_INPUT_CHARS so client-truncated input is never 413'd.
MAX_CHARS_PER_TEXT = 8192


@app.exception_handler(Exception)
async def global_exc_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {type(exc).__name__}: {exc}")
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "message": "internal server error",
                "type": "internal_error",
                "code": 500,
            }
        },
    )


@app.get("/v1/health")
async def health():
    if not loaded:
        return {
            "status": "loading",
            "model": model_name_arg,
            "dimensions": None,
            "device": None,
            "uptime_seconds": int(time.time() - start_time),
        }
    return {
        "status": "ok",
        "model": model_name_arg,
        "dimensions": dims,
        "device": device_name,
        "uptime_seconds": int(time.time() - start_time),
    }


def _load(mname: str, dev: str | None):
    global model, model_name_arg, device_name, dims, loaded
    logger.info(f"Loading model {mname} (device={dev or 'auto'})...")
    if dev is None:
        dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = SentenceTransformer(mname, device=dev)
    model_name_arg = mname
    device_name = dev
    dims = model.get_sentence_embedding_dimension()
    loaded = True
    logger.info(f"Loaded: {model_name_arg} ({dims} dims) on {device_name}")


def _count_tokens(texts: List[str]) -> int:
    if model is None or not hasattr(model, "tokenizer"):
        return sum(len(t.split()) for t in texts)
    try:
        return sum(len(model.tokenizer.encode(t)) for t in texts)
    except Exception:
        return sum(len(t.split()) for t in texts)


@app.post("/v1/embeddings")
async def embeddings(req: EmbeddingRequest):
    global loaded, load_task
    if not loaded:
        if load_task:
            await load_task
        if not loaded:
            _load(model_name_arg, device_name)

    texts = req.input if isinstance(req.input, list) else [req.input]
    if not texts:
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "message": "input must be a non-empty string or list",
                    "type": "invalid_request",
                    "code": 500,
                }
            },
        )

    if len(texts) > MAX_TEXTS_PER_REQUEST:
        return JSONResponse(
            status_code=413,
            content={
                "error": {
                    "message": f"too many texts: maximum {MAX_TEXTS_PER_REQUEST} per request",
                    "type": "request_too_large",
                    "code": 413,
                }
            },
        )
    for text in texts:
        if len(text) > MAX_CHARS_PER_TEXT:
            return JSONResponse(
                status_code=413,
                content={
                    "error": {
                        "message": f"text too long: maximum {MAX_CHARS_PER_TEXT} chars per text",
                        "type": "request_too_large",
                        "code": 413,
                    }
                },
            )

    try:
        loop = asyncio.get_event_loop()
        embeddings = (await loop.run_in_executor(None, model.encode, texts)).tolist()
    except Exception as e:
        logger.error(f"Encoding failed: {type(e).__name__}: {e}")
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "message": "embedding failed",
                    "type": "internal_error",
                    "code": 500,
                }
            },
        )

    data = [
        {"object": "embedding", "index": i, "embedding": emb}
        for i, emb in enumerate(embeddings)
    ]
    token_count = _count_tokens(texts)

    return {
        "object": "list",
        "data": data,
        "model": model_name_arg,
        "usage": {"prompt_tokens": token_count, "total_tokens": token_count},
    }


def _read_stdin_token(timeout_s: float = 1.0):
    """Read the SIDECAR_TOKEN=<token> handshake line from stdin, if piped.

    Returns None for standalone runs (tty, closed stdin, or no line within
    the timeout) so the server runs unauthenticated as before. Never logs
    the token value."""
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return None
        import select
        ready, _, _ = select.select([sys.stdin], [], [], timeout_s)
        if not ready:
            return None
        line = sys.stdin.readline()
    except Exception:
        return None
    if not line:
        return None
    prefix = "SIDECAR_TOKEN="
    if not line.strip().startswith(prefix):
        return None
    token = line.strip()[len(prefix):].strip()
    return token or None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("PI_SEARCH_EMBEDDING_PORT", "8765")))
    parser.add_argument("--model", type=str, default=os.environ.get("PI_SEARCH_EMBEDDING_MODEL", "all-MiniLM-L6-v2"))
    parser.add_argument("--device", type=str, default=os.environ.get("SIDECAR_DEVICE"))
    args = parser.parse_args()

    global model_name_arg, _auth_token
    model_name_arg = args.model
    # Manager handshake: token line on stdin enables auth; absent (standalone
    # runs) keeps the server unauthenticated. The value itself is never logged.
    _auth_token = _read_stdin_token()
    logging.getLogger("sidecar").info(
        "Sidecar auth enabled" if _auth_token else "Sidecar auth disabled (no token on stdin)"
    )

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    print(f"SIDECAR_PORT={args.port}", flush=True)

    def handle_sigterm(signum, frame):
        logger.info("Received SIGTERM, shutting down")
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_sigterm)

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
