# Validation scope

The publication preparation used upstream v0.6.4 (`f639e7c`) as the base. Checks
were performed locally on macOS on October 6, 2026, using the existing dependency
installations and the locked Python environment.

| Check | Local result |
| --- | --- |
| `pnpm format-and-lint:fix` | Passed; two informational template-literal suggestions in an inherited test |
| `pnpm type-check` | Passed |
| `pnpm test` | 822 passed, 10 skipped; 110 test files passed and 4 skipped |
| Pipeline `uv run --frozen --group dev pytest` | 13 passed |
| Pipeline Ruff lint and formatting | Passed |
| Enhanced Compose configuration | Passed with disposable placeholder credentials; no external worktree paths |
| Application and pipeline Docker builds | Passed on Linux/arm64 from a clean public checkout with the final Dockerfile patch |
| Isolated pipeline container startup and `/health` | Passed without host volumes or live credentials |

[GitHub CI on the initial enhancement commit](https://github.com/JeremyL691/riffado/actions/runs/37580537050)
also passed all five jobs, including the application build. With its disposable
Postgres service enabled, the TypeScript suite reported 826 passed and 6 skipped;
the pipeline suite reported 13 passed. This is a separate result from the local
suite above.

The Docker dependency stage follows the upstream pnpm lockfile installation fix,
and Bun is pinned to 1.4.0. Builds used no real credentials or source-map upload
secrets. Inherited non-fatal Edge Runtime, build-time auth configuration, and
PostHog build-argument diagnostics remain; a successful build is not a claim that
the project is warning-free. The final runtime image was checked for its server
and migration artifacts and contained neither `.env` nor Git metadata.

The pipeline tests cover chunk boundaries, source-audio timestamp context,
timestamp rejection and restoration, text-only responses, durable store reopen,
retry behavior, cancellation state, and API authentication. The TypeScript suite
includes the modified archive export tests.

Skipped tests are not counted as evidence of a working external integration.
The local checks do not establish real-account Plaud behavior, live provider
transcription quality, recovery through every container failure, 24-hour
endurance, full timeline backup/restore parity, or performance/cost improvements.

GitHub CI runs TypeScript checks, tests, and an application build, plus the
pipeline tests and Python lint checks, on pushes to `enhanced`. Its result must
be assessed independently from these local checks. No enhanced container release
or end-to-end deployment certification is implied by publishing the source.
