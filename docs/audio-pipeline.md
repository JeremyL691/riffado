# Audio Preprocessing Pipeline

The optional service prepares long recordings before server-side speech
recognition. PLAUD sync and the stored source audio remain unchanged. The
player continues to use the original audio object.

## Enablement

The feature is disabled by default and is limited to self-hosted deployments.
Set `AUDIO_PIPELINE_ENABLED=true` and configure a shared random
`AUDIO_PIPELINE_TOKEN` of at least 32 characters in the Compose environment.
Compose passes that token to Riffado Core and the private pipeline container.
The provider API key stays encrypted in Riffado and is used only while Core
forms each chunk request.

For a fresh installation, copy `.env.example` to `.env` and set separate random
values for `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and
`AUDIO_PIPELINE_TOKEN`. `openssl rand -hex 32` produces a suitable value; run it
separately for every secret. Set `APP_URL` to the address you will use.

The enhanced overlay builds the modified application locally, enables the
pipeline, and prevents an unmodified upstream image from being pulled:

```sh
docker compose -f docker-compose.yml -f docker-compose.enhanced.yml up -d --build
```

The pipeline API is available only on the Compose network. Its SQLite WAL and
temporary workspace use the `audio-pipeline-data` volume. The service is
limited to one active recording job, two STT requests, two CPUs, and 2 GiB of
memory. A 24-hour recording needs about 2.76 GB for decoded PCM, in addition to
the original audio and temporary workspace; jobs pause with a disk-space error
when that budget is unavailable.

The overlay enables `AUDIO_PIPELINE_ENABLED` explicitly. To disable processing
while retaining the fork, use a local Compose override that sets this application
environment value to `"false"`. New requests return to the original transcription
path. Browser transcription is unchanged, and existing transcripts are not
reprocessed automatically.

## Providers and job controls

Select a server provider in Riffado's settings before requesting transcription.
The bridge uses the existing provider configuration for OpenAI-style, Gemini,
and chat-style requests. Timestamp support depends on the selected model and its
actual response. Gemini and chat-style requests currently provide text only.
This v0.6.4-based fork does not contain later upstream ElevenLabs integration.

The dashboard displays the current processing phase and progress. Cancel stops
the task; Retry requeues failed work while retaining completed chunk results.
Service restart recovery uses the durable job store and VAD checkpoint files.
Disk-space pauses are revisited automatically. These are implemented recovery
paths, not a guarantee that every provider can avoid a duplicate billable
request after a network interruption.

## Data and upgrades

Original recordings stay in the configured Riffado storage. The
`audio-pipeline-data` volume contains SQLite state, temporary source audio,
decoded PCM, checkpoints, and intermediate chunk results. Treat this volume as
sensitive data. It is separate from Core's encrypted database. Temporary audio
is removed after Core acknowledges a persisted result or cancellation is
finalized. Never commit a copy of this volume.

Back up Core's database, its encryption key, recording storage, and the pipeline
volume before an upgrade. The encryption key is required to recover encrypted
content. Do not use volume-deleting Compose commands as an ordinary restart.

This branch starts at upstream v0.6.4 and has its own `0036` and `0037`
migrations. Later upstream uses those numbers for different changes. Switching
between this fork and later upstream requires a reviewed migration plan; it is
not a drop-in image swap. Reverting to an upstream image would also hide the
fork's timeline and processing state, even though the added columns are retained.

## Processing contract

The bundled Silero ONNX asset is pinned by SHA-256 and checked before use. The
pipeline decodes through FFmpeg to disk-backed 16 kHz mono PCM, detects speech,
and creates continuous, non-overlapping chunks. Gaps longer than 1.5 seconds
are omitted; shorter pauses stay in the audio. Chunk boundaries prefer pauses
near 120 seconds and never exceed 170 seconds. Each speech run may include up
to 50 ms of adjacent source audio at its end as timestamp-rounding context; this
does not bridge long pauses or change the chunk's absolute source offset.

Chunk times use integer samples from the original recording. Provider-native
segment timestamps are validated before conversion to absolute milliseconds.
If timestamps are missing or invalid, Core stores the complete text with job
status `needs_alignment`; it does not invent positions. Search and summaries
continue to use the full transcript text. Full-data exports include a
versioned `timeline.json` for transcripts with validated timing data.

The service exposes authenticated job submit, status, result, retry, cancel,
and acknowledge endpoints under `/v1/jobs`. Its only unauthenticated endpoint
is `/health` for container health checks.
