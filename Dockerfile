# Full Memory Hub + Knowledge image with the Studio Design UI.
# Memory Core remains the separately pinned upstream image in compose.yaml.
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g npm@11 --no-audit --no-fund

FROM base AS panel-ui-builder
WORKDIR /build/panel-web
COPY MemoryPanel/web/package*.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund
COPY MemoryPanel/web/ ./
RUN npm run build

FROM base AS panel-builder
WORKDIR /build/panel
COPY MemoryPanel/package*.json ./
RUN npm install --no-audit --no-fund
COPY MemoryPanel/ ./
COPY --from=panel-ui-builder /build/panel-web/dist ./web/dist
RUN npm run build

FROM base AS knowledge-builder
WORKDIR /build/knowledge
COPY MemoryKnowledge/package*.json ./
RUN npm install --no-audit --no-fund
COPY MemoryKnowledge/ ./
RUN npm run build

FROM node:22-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PANEL_PORT=8125 KNOWLEDGE_PORT=8424 REMOTE_INSTANCE_URL="" KNOWLEDGE_LLM_BINDING_SYNC=1 LLM_MODE=custom LLM_PROTOCOL=openai LLM_PROVIDER=custom LLM_BASE_URL="" LLM_MODEL=Memory-Model KNOWLEDGE_DATA_DIR=/data/knowledge KNOWLEDGE_DB_PATH=/data/knowledge/knowledge.db LOG_LEVEL=info LOG_FORMAT=json
COPY --from=panel-builder /build/panel/dist /app/panel/dist
COPY --from=panel-builder /build/panel/node_modules /app/panel/node_modules
COPY --from=panel-builder /build/panel/package.json /app/panel/package.json
COPY --from=panel-builder /build/panel/web/dist /app/panel/web/dist
COPY --from=knowledge-builder /build/knowledge/dist /app/knowledge/dist
COPY --from=knowledge-builder /build/knowledge/node_modules /app/knowledge/node_modules
COPY --from=knowledge-builder /build/knowledge/package.json /app/knowledge/package.json
COPY --from=knowledge-builder /build/knowledge/openapi.yaml /app/knowledge/openapi.yaml
COPY deploy/panel-knowledge-combined/start-combined.sh /usr/local/bin/start-combined.sh
RUN chmod +x /usr/local/bin/start-combined.sh && mkdir -p /data/knowledge /app/panel/config && chown -R node:node /app /data/knowledge
USER node
EXPOSE 8125 8424
VOLUME ["/data/knowledge"]
HEALTHCHECK --interval=20s --timeout=8s --retries=15 --start-period=45s CMD curl -fsS http://127.0.0.1:8125/health >/dev/null && curl -fsS http://127.0.0.1:8424/health >/dev/null || exit 1
CMD ["/usr/local/bin/start-combined.sh"]
