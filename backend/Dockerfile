# ---- builder ----
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/package.json ./backend/
RUN corepack enable && pnpm install --frozen-lockfile --filter @mythrun/backend
COPY backend/ ./backend/
WORKDIR /app/backend
RUN pnpm build
RUN pnpm --filter @mythrun/backend deploy --prod /app/deploy

# ---- runtime ----
FROM node:24-alpine
RUN apk add --no-cache dumb-init
WORKDIR /app
RUN addgroup -S mythrun && adduser -S mythrun -G mythrun
COPY --from=builder --chown=mythrun:mythrun /app/deploy ./
USER mythrun
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1
CMD ["dumb-init", "node", "dist/server.js"]
