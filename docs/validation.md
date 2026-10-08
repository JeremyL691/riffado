# Validation record

## Baseline and scope

The enhancement is based on upstream commit `b518379`. The long-audio
enhancement baseline is `5337fdb` and uses migrations `0039` and `0040`. The
five CI jobs recorded for that baseline passed. A previous local run on the
baseline reported 1,048 tests passed and 9 skipped. Those are historical
baseline results, not evidence for the changes in this finalization.

This finalization did not rerun the existing full local test suite or claim a
new CI result. It ran targeted tests for the changed behavior, static checks,
isolated restore and export verification, and current-machine deployment checks.

## Incremental source checks

| Check | Result |
| --- | --- |
| TypeScript targeted tests for timeline repair, provider bridging, archive builder and worker, and Core recovery | 69 passed across 6 files |
| Python targeted merge, API, restart, retry, cancellation, disk-budget, and duration-bound tests | 27 passed |
| `pnpm exec tsc --noEmit` | Passed |
| Biome on changed TypeScript files | Passed |
| Ruff on changed pipeline source and tests | Passed |
| Ruff formatting check on changed pipeline source and tests | Passed |

The Core recovery test injects a failure after the result transaction body but
before commit, then retries from the persisted sidecar result. It also injects
an acknowledgement failure after a successful Core commit and verifies that
the finalization reconciler acknowledges the result after restart without
repeating post-processing or the completion event. Pipeline recovery tests
reopen the SQLite job store after a completed chunk, retry a failed chunk while
reusing successful chunks, resume after a disk-budget pause, and preserve
cancellation across restart. The API accepts the exact 24-hour input ceiling
and rejects a duration one millisecond above it.

## Isolated backup, restore, repair, and export

A private backup was captured outside the repository. It contains the logical
Postgres dump, audio and storage volumes, an SQLite online backup, the pipeline
work directory, rollback rows for the two affected recordings, and the matching
encryption key in separately restricted storage. The pre- and post-capture
database fingerprints matched; the dump was listable, the SQLite backup passed
`PRAGMA integrity_check`, and the volume archives were readable. The SQLite
snapshot contained 7 jobs and 638 chunk records.

The backup was restored into a separate internal-network Compose project with
dedicated volumes and local images. The restored database fingerprint matched
the backup. Audio-file hashes matched the backup, the storage volume was empty
as expected, and the restored Core and pipeline health checks passed. The
isolated environment had no external network route and made no Plaud or AI
provider request.

An offline repair preview read the saved provider responses and produced:

| Recording | Preview result |
| --- | --- |
| 21 minutes | 152 segments; unchanged, `native` |
| 81 minutes | 509 valid segments; 11 whitespace-only segments ignored for positioning, `native` |
| 4 hours 26 minutes | 513 segments; two 25 ms end-time corrections, `normalized` |

The preview skipped an older generation because a newer transcription task
exists. Applying the two eligible repairs on the isolated restore completed
both Core jobs and kept the pipeline acknowledgement set. Text, summary, and
audio hashes matched their pre-repair values. The original provider chunk
responses remained available in SQLite. The private repair plan and rollback
data are not in the repository.

A ZIP built from the isolated restore passed archive integrity checks. Its
manifest described all three recordings; audio, transcript, summary, and
timeline checks matched the restored data, including timeline counts 152, 509,
and 513 and the two normalization records. Negative checks verified that a
pre-cancelled archive build creates no output, a truncated archive fails
integrity validation, and a missing-audio archive is rejected by the worker,
deleted from storage, marked permanently failed, and not announced as ready.

## Current-machine verification

The final app and pipeline images were built and deployed with the existing
database container and data volumes preserved. Both runtime containers report
healthy. `GET /api/health` returned `{"status":"ok","version":"0.6.4"}` and
the pipeline `/health` endpoint returned a healthy response. No transcription
job was active after the repair run.

The offline repair and paused-seek checks previously covered three local
recordings. That dataset was subsequently removed at the user's request, along
with its pipeline job/chunk records and temporary repair/backup artifacts. No
per-recording data from that dataset is retained here, and those removed records
have not been tested since deletion. The earlier results are historical evidence
only, not current local-data acceptance.

On the recording that remains, paused timeline seeking still updates the player
clock and active-segment marker together. The dashboard had no horizontal
overflow at 320, 768, 1024, or 1440 CSS pixels in the earlier responsive check.

On the remaining local recording, paused seeking to the second timeline segment
set the audio clock to 24.934 seconds and activated the 00:00:24 marker. Playing
for 4.2 seconds advanced the native audio clock to 29.834 seconds and moved the
active marker to 00:00:28, with no media error. Playback was paused after the
check.

The dashboard initially reported React hydration error #418. The host runs in
PDT while the app container runs in UTC, and the server/client date-group labels
could therefore differ around midnight. The list now uses a time-zone-stable
month label during server rendering, then applies the user's local date groups
after hydration. A fresh page load after deployment added no new #418 entry;
older entries remain in this browser session's console history.

## Limits

The ElevenLabs chunk path is connected and passed controlled-response and
local-mock tests without an ElevenLabs key or a billable request. Real-account
recognition quality remains unverified. The 24-hour setting is an enforced
input ceiling; this work does not claim a real 24-hour endurance test. No
comparative accuracy, cost, or latency benefit has been measured. A successful
ZIP export is a user-data export, not an operations restore package, and there
is no ZIP import endpoint.
