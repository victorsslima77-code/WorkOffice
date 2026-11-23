# ==============================================================================
# WorkOffice — Dockerfile do Worker de Agentes (Node.js 22 + ffmpeg + yt-dlp + faster-whisper)
# ==============================================================================
FROM node:22-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-venv \
    python3-pip \
    curl \
    ca-certificates \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*

# Ambiente Python isolado com faster-whisper (transcricao local real preservando idioma original)
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir faster-whisper
ENV PATH="/opt/venv/bin:$PATH"
ENV HF_HOME="/app/.whisper-cache"
ENV WHISPER_MODEL_SIZE="base"
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')" || true

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/web/package.json ./apps/web/package.json

RUN pnpm install --frozen-lockfile --filter @workoffice/shared --filter @workoffice/worker

COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker

RUN pnpm --filter @workoffice/shared build && pnpm --filter @workoffice/worker build

ENV NODE_ENV=production
ENV ENABLE_NATIVE_FFMPEG=true

CMD ["node", "apps/worker/dist/main.js"]
