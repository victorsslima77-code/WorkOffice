# ==============================================================================
# WorkOffice — Dockerfile do Worker de Agentes (Node.js 22 + ffmpeg + yt-dlp)
# ==============================================================================
FROM node:22-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    curl \
    ca-certificates \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/worker/package.json ./apps/worker/package.json

RUN pnpm install --frozen-lockfile --filter @workoffice/shared --filter @workoffice/worker

COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker

RUN pnpm --filter @workoffice/shared build && pnpm --filter @workoffice/worker build

ENV NODE_ENV=production

CMD ["node", "apps/worker/dist/main.js"]
