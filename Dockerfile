FROM node:20-alpine

# better-sqlite3 is a native module — needs build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (layer cache — only re-runs on package.json changes)
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY . .

# Render injects PORT at runtime; default fallback for local docker runs
EXPOSE 3000

CMD ["node", "server.js"]
