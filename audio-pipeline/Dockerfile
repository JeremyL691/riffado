FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AUDIO_PIPELINE_DATA_DIR=/data

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home pipeline
RUN pip install --no-cache-dir uv==0.12.23

WORKDIR /app
COPY pyproject.toml README.md uv.lock ./
COPY src ./src
COPY models ./models
RUN uv sync --frozen --no-dev \
    && mkdir -p /data \
    && chown -R pipeline:pipeline /app /data

ENV PATH="/app/.venv/bin:${PATH}"
USER pipeline
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8100/health', timeout=2)"
CMD ["uvicorn", "audio_pipeline.app:app", "--app-dir", "src", "--host", "0.0.0.0", "--port", "8100"]
