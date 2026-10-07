from __future__ import annotations

import uvicorn


def main() -> None:
    uvicorn.run("audio_pipeline.app:app", host="0.0.0.0", port=8100)
