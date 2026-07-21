# ─────────────────────────────────────────────
# Stage 1: Builder
# Build context: backend/ (monorepo root)
# ─────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/ ./packages/
COPY apps/analytics-service/ ./apps/analytics-service/

RUN npm ci --workspace=@futurespark/analytics-service --include-workspace-root

# Build shared packages in dependency order
RUN npm run build -w @futurespark/constants
RUN npm run build -w @futurespark/enums
RUN npm run build -w @futurespark/logger
RUN npm run build -w @futurespark/response
RUN npm run build -w @futurespark/types
RUN npm run build -w @futurespark/database
RUN npm run build -w @futurespark/middleware
RUN npm run build -w @futurespark/utils

# Generate Prisma client (dummy URL; real URL injected at runtime)
ENV ANALYTICS_DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN cd apps/analytics-service && npx prisma generate

# Build the analytics-service TypeScript
RUN npm run build -w @futurespark/analytics-service

# ─────────────────────────────────────────────
# Stage 2: Production Runner
# ─────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/analytics-service/dist ./apps/analytics-service/dist
COPY --from=builder /app/apps/analytics-service/package.json ./apps/analytics-service/package.json
COPY --from=builder /app/apps/analytics-service/prisma ./apps/analytics-service/prisma
COPY --from=builder /app/packages ./packages

EXPOSE 3003

CMD ["node", "apps/analytics-service/dist/server.js"]