# Audio pipeline backup, restore, and verification

This runbook separates the per-user full-data ZIP export from an operations
backup. The ZIP is plaintext and useful for inspection or migration of user
content. It is not an import package. Operations recovery uses the encrypted
Postgres database, the encryption key stored separately, the audio and storage
volumes, and the pipeline's SQLite state and work directory.

## Capture a stable backup

Use a private destination outside the repository. Restrict the directory to the
operator account (`0700`) and each file to `0600`. Do not place real recordings,
database dumps, pipeline workspaces, keys, or repair plans in Git.

Before capture, confirm there are no `queued`, `submitted`, `running`, or
`paused` audio-pipeline jobs. Capture a compact fingerprint of recording rows,
transcription ciphertext, summary ciphertext, and pipeline job generations.
Keep only counts and hashes in the verification log. Capture:

1. A PostgreSQL custom-format logical dump.
2. A tar snapshot of the audio volume.
3. A tar snapshot of the storage volume.
4. A SQLite online backup of `/data/pipeline.sqlite3`.
5. A tar snapshot of the pipeline data volume, including its work directory.
6. The matching `ENCRYPTION_KEY` in separate, access-controlled secure storage.

Use SQLite's backup API rather than copying the live database file:

```python
import sqlite3

with sqlite3.connect("/data/pipeline.sqlite3") as source:
    with sqlite3.connect("/private/pipeline.sqlite3") as snapshot:
        source.backup(snapshot)
```

Record archive sizes and SHA-256 hashes. Verify the Postgres dump with
`pg_restore --list`, run `PRAGMA integrity_check` on the SQLite snapshot, and
list each tar archive. Recompute the compact fingerprint after capture. If
recording, transcription, summary, or task fingerprints changed, discard that
set as an inconsistent cross-volume snapshot and capture again in a stable
window.

## Restore into an isolated stack

Use a distinct Compose project name, distinct named volumes, and loopback-only
ports. Mark its Docker network internal so restored jobs cannot reach Plaud,
ElevenLabs, Gemini, OpenAI, S3, mail, or other external services. Do not use the
production Compose project name or its volumes.

Restore in this order:

1. Create the isolated volumes and start only its Postgres service.
2. Restore the logical Postgres dump into the empty database.
3. Restore the audio and storage volume archives.
4. Restore the pipeline work directory, then replace its SQLite database with
   the online backup and remove any stale SQLite WAL/SHM files from the restored
   copy.
5. Configure the original encryption key through a protected environment
   source. Disable registration, automatic sync, and live provider calls.
6. Start the isolated Core service and verify its health endpoint and database
   migrations. Keep the pipeline stopped until the restore is verified.

Compare counts and hashes for recordings, decrypted transcripts, decrypted
summaries, and audio files. Confirm timeline source values (`native` or
`normalized`), correction metadata, latest task generation, and task status.
Check that the restored sidecar SQLite file passes its integrity check and that
acknowledged chunk results and checkpoints remain readable.

## ZIP export verification

From the restored instance, create a full-data ZIP and verify it without
credentials or an external storage service:

- `unzip -t` succeeds for the archive.
- `manifest.json` describes each restored recording.
- Included audio bytes match the restored source audio hash.
- Transcript and summary content hashes match the decrypted database values.
- `timeline.json` contains `schema_version: 1`, the stored timestamp source,
  processing configuration, and all segment corrections and speaker chunk
  identities.
- A missing or unreadable audio object is marked `included: false` with a reason
  in the manifest. The export worker must fail the job, discard the partial ZIP,
  and send no ready notification; such an archive is never a successful backup.

Run negative checks as well: the builder must report a missing audio file in
the manifest and the worker must fail and discard the incomplete archive;
cancelling an export must not leave a completed export record; and a truncated
or altered copy of the ZIP must fail archive integrity validation. Do not
weaken these failures into a successful-complete status.

## Timeline repair of acknowledged recordings

The repair command reads saved chunk results from SQLite and asks Core to
preview a hash-bound plan. Preview is read-only. The plan contains transcript
text, so store it privately. Apply only the reviewed plan:

```sh
docker compose exec audio-pipeline python -m audio_pipeline.repair \
  --preview-output /data/repairs/timeline-repair.json
docker compose exec audio-pipeline python -m audio_pipeline.repair \
  --apply /data/repairs/timeline-repair.json
```

Core checks that the recording still exists, the generation is current, no job
is active, and the current decrypted transcript hash matches the plan. It
updates the encrypted timeline, its source, the timestamp-policy snapshot, and
the corresponding task completion state in one transaction. The pipeline
acknowledgement remains set. The sidecar's saved vendor responses are retained;
no provider request, summary generation, title update, or completion webhook is
issued. Reapplying the same plan is idempotent; if Core commits but the sidecar
sync is interrupted, rerun the same plan to complete the mirror and produce a
receipt.

The endpoint timestamp policy is `chunk_end_guard_50ms_v1`. It ignores
whitespace-only segment text for locating while preserving the full transcript.
An end-time overrun of at most 50 ms is clamped to the actual chunk end and
records the original end, normalized end, chunk index, and reason. Larger
errors remain `needs_alignment`.

## Scope of evidence

Controlled ElevenLabs responses and local mocks verify the Core-to-provider
route without an ElevenLabs key or a billable call. This establishes that the
enhanced path is connected and simulated; it does not establish real-account
recognition quality. The enforced 24-hour maximum is not a completed 24-hour
durability test. Cost and accuracy improvements remain unmeasured.
