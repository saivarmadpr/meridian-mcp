# --- build stage ---
FROM node:22-slim AS builder
WORKDIR /app

# Build toolchain for native deps (argon2) in case a prebuilt binary is unavailable.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build

# Drop devDependencies but keep the already-built native binaries.
RUN npm prune --omit=dev

# --- runtime stage ---
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY package.json ./

# Run as the built-in unprivileged user.
USER node

# Railway injects PORT; the server also defaults to 8080.
EXPOSE 8080
CMD ["node", "dist/index.js"]
