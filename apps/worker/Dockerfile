# ==============================================================================
# WorkOffice — Dockerfile do Worker de Agentes (Node.js 22 + ffmpeg + yt-dlp + faster-whisper)
# ==============================================================================
FROM node:22-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu-core \
    python3 \
    python3-venv \
    python3-pip \
    curl \
    xz-utils \
    ca-certificates \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && mkdir -p /opt/ytdlp-ffmpeg \
  && (if [ "$(uname -m)" = "x86_64" ]; then \
        curl -fSL https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz \
        | tar -xJ --strip-components=2 -C /opt/ytdlp-ffmpeg --wildcards '*/bin/ffmpeg' '*/bin/ffprobe'; \
      fi || echo "[Dockerfile] yt-dlp FFmpeg static opcional indisponivel; usando /usr/bin/ffmpeg") \
  && rm -rf /var/lib/apt/lists/*

# Ambiente Python isolado com yt-dlp[default,curl-cffi] (yt-dlp-ejs + TLS impersonation) + faster-whisper
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
  && (/opt/venv/bin/pip install --no-cache-dir --upgrade "yt-dlp[default,curl-cffi]" \
      || /opt/venv/bin/pip install --no-cache-dir --upgrade "yt-dlp[default]") \
  && (/opt/venv/bin/pip install --no-cache-dir --only-binary=:all: faster-whisper \
      || echo "[Dockerfile] faster-whisper wheel indisponivel; seguindo com yt-dlp subs + Cloud STT")
ENV PATH="/opt/venv/bin:$PATH"
ENV HF_HOME="/app/.whisper-cache"
ENV WHISPER_MODEL_SIZE="small"

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
