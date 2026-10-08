from pathlib import Path

import httpx

from audio_pipeline.config import AppConfig, ServerConfig


async def test_api_auth_idempotent_submit_status_and_cancel(tmp_path: Path, monkeypatch) -> None:
    # The ASGI module exports a default app for Uvicorn. Keep that import-time
    # default inside this test's temporary directory as well.
    monkeypatch.setenv("AUDIO_PIPELINE_DATA_DIR", str(tmp_path / "default-app"))
    from audio_pipeline.app import create_app

    token = "local-test-token-that-is-long-enough-123"
    app = create_app(AppConfig(server=ServerConfig(data_dir=tmp_path / "api", api_token=token)))
    # Exercise the HTTP contract without starting a provider/network task.
    app.state.service.schedule = lambda _job_id: None
    payload = {
        "idempotency_key": "core-job-api",
        "riffado_job_id": "core-job-api",
        "duration_ms": 90_000,
    }

    await app.state.service.start()
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://pipeline.test"
        ) as client:
            unauthorized = await client.post("/v1/jobs", json=payload)
            assert unauthorized.status_code == 401
            headers = {"Authorization": f"Bearer {token}"}
            first = await client.post("/v1/jobs", json=payload, headers=headers)
            second = await client.post("/v1/jobs", json=payload, headers=headers)
            assert first.status_code == 202
            assert first.json()["created"] is True
            assert second.json()["created"] is False
            assert second.json()["job_id"] == first.json()["job_id"]

            job_id = first.json()["job_id"]
            status = await client.get(f"/v1/jobs/{job_id}", headers=headers)
            assert status.status_code == 200
            assert status.json()["status"] == "queued"

            cancelled = await client.post(f"/v1/jobs/{job_id}/cancel", headers=headers)
            assert cancelled.status_code == 200
            assert app.state.store.is_cancelled(job_id)

            repair_job, _ = app.state.store.create(
                "core-job-repair-api", "core-job-repair-api", 60_000
            )
            app.state.store.update(
                repair_job["id"],
                status="needs_alignment",
                result_json={"schema_version": 1, "status": "needs_alignment"},
            )
            assert app.state.store.acknowledge(repair_job["id"])
            repaired = {
                "schema_version": 1,
                "status": "completed",
                "timeline": [{"start_ms": 0, "end_ms": 100, "text": "word"}],
            }
            unauthorized_repair = await client.post(
                f"/v1/jobs/{repair_job['id']}/repair", json=repaired
            )
            assert unauthorized_repair.status_code == 401
            repair_response = await client.post(
                f"/v1/jobs/{repair_job['id']}/repair",
                json=repaired,
                headers=headers,
            )
            assert repair_response.status_code == 200
            assert repair_response.json()["status"] == "acknowledged"
            assert app.state.store.get(repair_job["id"])["result"] == repaired
    finally:
        await app.state.service.stop()


async def test_submit_accepts_exact_24_hour_limit_and_rejects_one_ms_over(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("AUDIO_PIPELINE_DATA_DIR", str(tmp_path / "default-app"))
    from audio_pipeline.app import create_app

    token = "local-test-token-that-is-long-enough-123"
    app = create_app(AppConfig(server=ServerConfig(data_dir=tmp_path / "api", api_token=token)))
    app.state.service.schedule = lambda _job_id: None
    await app.state.service.start()
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://pipeline.test"
        ) as client:
            headers = {"Authorization": f"Bearer {token}"}
            accepted = await client.post(
                "/v1/jobs",
                headers=headers,
                json={
                    "idempotency_key": "limit-24h",
                    "riffado_job_id": "limit-24h",
                    "duration_ms": 86_400_000,
                },
            )
            assert accepted.status_code == 202

            rejected = await client.post(
                "/v1/jobs",
                headers=headers,
                json={
                    "idempotency_key": "over-limit",
                    "riffado_job_id": "over-limit",
                    "duration_ms": 86_400_001,
                },
            )
            assert rejected.status_code == 422
    finally:
        await app.state.service.stop()
