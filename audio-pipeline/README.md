# Riffado Audio Preprocessing Pipeline

Private, model-independent service for long PLAUD recordings. Riffado Core
keeps provider credentials and storage access; this service receives only a
short-lived job identity and calls authenticated Core bridge endpoints.

The service decodes to disk-backed mono 16 kHz PCM, runs the pinned Silero
ONNX model, makes continuous non-overlapping chunks, and restores provider
segment timestamps to absolute source milliseconds. It keeps task and chunk
state in SQLite WAL under `/data`; successful intermediate chunk results are
reused after restart. Working audio is removed only after Core acknowledges a
persisted result. Chunk plans may retain up to 50 ms of adjacent source audio
after a speech run as timestamp-rounding context. This is real audio included
in the chunk bounds, not timestamp clamping, and it never joins separate speech
runs across the configured long-silence threshold.

Run locally with `uvicorn audio_pipeline.app:app --host 0.0.0.0 --port 8100`.
The API is bearer-token protected. `/health` is the only unauthenticated route.
