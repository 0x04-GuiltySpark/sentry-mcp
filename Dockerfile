# Keep Node 22 and Debian Bookworm aligned with the reviewed Sentry MCP pin.
FROM node:22-bookworm-slim AS source

LABEL org.opencontainers.image.title="Streaming Tech Sentry MCP compatibility wrapper" \
      org.opencontainers.image.source="https://github.com/Streaming-Tech/sentry-mcp"

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.28.11 --ignore-scripts

# Fetch and verify the reviewed upstream source at build time only.
COPY package.json /tmp/sentry-mcp-package.json
RUN SENTRY_MCP_REF="$(node -e 'const ref = require("/tmp/sentry-mcp-package.json").sentryMcpRef; if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error("sentryMcpRef must be a full lowercase commit SHA"); process.stdout.write(ref)')" \
    && git init . \
    && git remote add origin https://github.com/getsentry/toolkit.git \
    && git fetch --depth 1 origin "${SENTRY_MCP_REF}" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${SENTRY_MCP_REF}" \
    && rm -rf .git \
    && rm /tmp/sentry-mcp-package.json

COPY upstream-server.patch /tmp/upstream-server.patch
RUN git apply --check /tmp/upstream-server.patch \
    && git apply /tmp/upstream-server.patch \
    && rm /tmp/upstream-server.patch

COPY package.json ./packages/sse-wrapper/package.json
COPY LICENSE.md ./packages/sse-wrapper/
COPY pnpm-lock.yml ./pnpm-lock.yaml
COPY pnpm-workspace.yml ./pnpm-workspace.yaml
# Prevent upstream packageManager pins from switching to another installer.
# Dependencies are integrity-locked; no package hooks or pnpmfile code execute.
RUN pnpm --pm-on-fail=ignore --filter streaming-tech-sentry-mcp... install --frozen-lockfile --ignore-scripts --ignore-pnpmfile

COPY server.ts ./packages/sse-wrapper/server.ts
COPY tsconfig.json ./packages/sse-wrapper/tsconfig.json
COPY biome.json ./packages/sse-wrapper/biome.json
COPY src ./packages/sse-wrapper/src

WORKDIR /app/packages/sse-wrapper
RUN chmod -R a+rX server.ts package.json LICENSE.md tsconfig.json biome.json src
RUN node node_modules/typescript/bin/tsc --noEmit

FROM source AS test
COPY tests ./tests
RUN chmod -R a+rX tests \
    && mkdir -p /app/node_modules/.vitest-cache \
    && chown node:node /app/node_modules/.vitest-cache
USER node
RUN node node_modules/@biomejs/biome/bin/biome format server.ts src tests
RUN node node_modules/@biomejs/biome/bin/biome lint server.ts src tests
# Limit test concurrency and allow for QEMU overhead when building ARM64 on AMD64.
RUN node node_modules/vitest/vitest.mjs run --maxWorkers=2 --testTimeout=30000

FROM source AS runtime
ENV NODE_ENV=production
ENV TSX_DISABLE_CACHE=1
WORKDIR /app/packages/sse-wrapper
USER node
RUN node --import tsx --input-type=module -e 'await import("./src/app.ts")'

CMD ["node", "--import", "tsx", "server.ts"]
