# ── Build stage: compile native modules (better-sqlite3) ─────────────
FROM node:20-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage: no compilers, non-root, persistent data volume ─────
FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/apex.db
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY *.js ./
COPY public ./public

# SQLite lives on a volume so journal/portfolio survive redeploys.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1

CMD ["node", "server.js"]
