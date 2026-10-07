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
    finally:
        await app.state.service.stop()
