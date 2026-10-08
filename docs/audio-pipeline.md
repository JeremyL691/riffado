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
The ElevenLabs path reuses Core's existing Scribe client for each audio chunk.
Core keeps the API key, applies the stored base-URL policy and request timeout,
and sends only the returned text and word timings to the private pipeline. New
jobs snapshot the diarization toggle and optional speaker-count hint. Older jobs
without those fields use the upstream diarization default and no speaker-count
hint. Speaker IDs are scoped to their source chunk; `speaker_0` in two chunks is
not evidence that the same person spoke in both.

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
volume before an upgrade. A Postgres dump and storage snapshot are the
operations-recovery set; the user's full-data ZIP is a portable export, not a
server restore package. The encryption key is required to recover encrypted
content and must be stored separately from the database backup. See the
[operations backup, restore, and verification runbook](audio-pipeline-operations.md).
Do not use volume-deleting Compose commands as an ordinary restart.

The enhancement branch is based on upstream commit `b518379`; its long-audio
baseline is `5337fdb`. This fork owns migrations `0039` and `0040`. Do not move a
database between this fork and upstream builds with different migration
histories without a reviewed migration plan. Reverting to an upstream image
would hide the fork's timeline and processing state even though its columns
remain in the database.

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
Whitespace-only provider segments are ignored for positioning, while the
provider's complete text remains unchanged. An end-time overshoot of up to and
including 50 ms is clamped to the actual chunk end and recorded on the segment
with its original end, corrected end, chunk index, and reason. Those timelines
use source `normalized`; unchanged provider timestamps use `native`. Larger
overshoots, invalid numbers, negative or unordered starts, zero-length results
after correction, and non-empty text without usable timestamps continue to
produce `needs_alignment`; no positions are invented. Search and summaries
continue to use the full transcript text.

Full-data ZIP exports keep `schema_version: 1` and include `timeline.json` with
the timestamp source, processing snapshot, speaker IDs and chunk indexes, and
per-segment correction records. Old timelines without these optional fields
remain readable. The offline repair command can preview the current acknowledged
alignment jobs and create a private, hash-bound plan. Run it inside the pipeline
container and review its counts before applying:

```sh
docker compose exec audio-pipeline python -m audio_pipeline.repair \
  --preview-output /data/repairs/timeline-repair.json
docker compose exec audio-pipeline python -m audio_pipeline.repair \
  --apply /data/repairs/timeline-repair.json
```

The plan contains plaintext transcript material. Keep it in the private
pipeline data volume or another access-restricted location; after successful
application it is replaced with a receipt. Apply verifies the current transcript
hash and latest task generation and refuses deleted recordings or active jobs.
It does not call a transcription provider or regenerate summaries.

The service exposes authenticated job submit, status, result, retry, cancel,
and acknowledge endpoints under `/v1/jobs`. Its only unauthenticated endpoint
is `/health` for container health checks.
