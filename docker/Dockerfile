# Multiturn Hunter - staging/production
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN useradd -u 1005 -m appuser \
    && mkdir -p .storage .telemetry \
    && chown -R appuser:appuser .storage .telemetry

USER appuser

EXPOSE 8010

CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8010}"]
