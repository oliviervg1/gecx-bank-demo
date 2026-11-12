# syntax=docker/dockerfile:1
# Single-origin multi-stage container for Cloudbank on Cloud Run + Direct IAP.
#
# Build context MUST be `cloudbank/` (for example:
#   docker build -f cloudbank/Dockerfile cloudbank
# or via `cloudbank/scripts/deploy_cloud_run.sh`).
#
# Preserves `/app/{proxy/src/proxy,shared,web/dist}` with an editable `.venv`
# install so `Path(__file__).resolve().parents[3]` in `proxy/main.py` and
# `proxy/relay.py` resolves `/app/shared` identically to local development.

FROM node:22-slim AS web-builder
WORKDIR /build/web

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY shared /build/shared
COPY web /build/web
# Never set VITE_PROXY_URL in single-origin container builds so
# tightenProductionCspPlugin locks script-src 'self' and connect-src 'self'.
RUN unset VITE_PROXY_URL && npm run build

FROM python:3.12-slim AS python-builder
WORKDIR /app/proxy

RUN python -m pip install --no-cache-dir "uv>=0.6,<1"
COPY proxy/pyproject.toml proxy/uv.lock /app/proxy/
COPY proxy/src /app/proxy/src
RUN uv sync --locked --no-dev

FROM python:3.12-slim AS runtime

RUN groupadd --system --gid 10001 cloudbank && \
    useradd --system --uid 10001 --gid 10001 --home-dir /app --no-create-home --shell /usr/sbin/nologin cloudbank

WORKDIR /app/proxy

COPY --chown=cloudbank:cloudbank shared /app/shared
COPY --chown=cloudbank:cloudbank proxy/pyproject.toml proxy/uv.lock /app/proxy/
COPY --chown=cloudbank:cloudbank proxy/src /app/proxy/src
COPY --chown=cloudbank:cloudbank --from=python-builder /app/proxy/.venv /app/proxy/.venv
COPY --chown=cloudbank:cloudbank --from=web-builder /build/web/dist /app/web/dist

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PROXY_HOST=0.0.0.0 \
    PROXY_ALLOW_REMOTE=1 \
    PROXY_STATIC_DIR=/app/web/dist \
    PROXY_MAX_SESSION_SECONDS=3300

USER cloudbank:cloudbank
EXPOSE 8080

CMD ["/app/proxy/.venv/bin/python", "-m", "proxy"]
