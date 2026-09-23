FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base

RUN corepack enable && corepack prepare pnpm@11.1.2 --activate

# ─── deps ──────────────────────────────────────────────────────────────────────
FROM base AS deps
# Compile SQLite when a prebuilt binary is unavailable for the host platform.
ARG APK_MIRROR=https://dl-cdn.alpinelinux.org
RUN sed -i "s|https://dl-cdn.alpinelinux.org|${APK_MIRROR}|g" /etc/apk/repositories \
 && apk --timeout 60 add --no-cache python3 make g++
WORKDIR /app
ENV HUSKY=0
COPY package.json pnpm-lock.yaml .npmrc ./
# Copy pnpm workspace config (controls which packages can run build scripts)
COPY pnpm-workspace.yaml ./
# Install dependencies
# pnpm will only allow approved packages to run scripts (see pnpm-workspace.yaml)
RUN --mount=type=cache,id=agentictm-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store --network-concurrency=4

# ─── builder ───────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
ENV HUSKY=0
ENV CI=true
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml .npmrc ./
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN pnpm build

# ─── runner ────────────────────────────────────────────────────────────────────
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Placeholder defaults so the image boots without crashing.
# Override with real values at runtime (docker -e / compose / .env).
# No DATABASE_URL on purpose: without it the app runs in local workspace mode
# (per-project SQLite) and /api/health stays green; a dummy value would make
# the Postgres probe fail and the container report unhealthy.
ENV LLM_PROVIDER=ollama
ENV OLLAMA_BASE_URL=http://localhost:11434
ENV OLLAMA_QUICK_MODEL=qwen3.5:4b
ENV OLLAMA_DEEP_MODEL=qwen3.5:9b
ENV CHROMA_HOST=localhost
ENV CHROMA_PORT=8000
ENV EMBEDDING_PROVIDER=ollama
ENV EMBEDDING_MODEL=qwen3-embedding:4b

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Standalone output (requires output: 'standalone' in next.config.ts)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/build/pipeline-worker.cjs ./build/pipeline-worker.cjs

RUN mkdir -p /app/knowledge_base /home/nextjs/.agentictm/projects \
 && chown -R nextjs:nodejs /app/knowledge_base /home/nextjs/.agentictm
ENV CREDENTIALS_READ_ONLY=true

USER nextjs

EXPOSE 8080
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "server.js"]
