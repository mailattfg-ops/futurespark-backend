# ─────────────────────────────────────────────
# Stage 1: Builder
# Build context: backend/ (monorepo root)
# ─────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/ ./packages/
COPY apps/communication-service/ ./apps/communication-service/

RUN npm ci --workspace=@futurespark/communication-service --include-workspace-root

# Build shared packages in dependency order
RUN npm run build -w @futurespark/constants
RUN npm run build -w @futurespark/enums
RUN npm run build -w @futurespark/logger
RUN npm run build -w @futurespark/response
RUN npm run build -w @futurespark/types
RUN npm run build -w @futurespark/database
RUN npm run build -w @futurespark/middleware
RUN npm run build -w @futurespark/queue
RUN npm run build -w @futurespark/events
RUN npm run build -w @futurespark/utils

# Generate Prisma client (dummy URL; real URL injected at runtime)
ENV COMM_DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN cd apps/communication-service && npx prisma generate

# Build the communication-service TypeScript
RUN npm run build -w @futurespark/communication-service

# ─────────────────────────────────────────────
# Stage 2: Production Runner
# ─────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/communication-service/dist ./apps/communication-service/dist
COPY --from=builder /app/apps/communication-service/package.json ./apps/communication-service/package.json
COPY --from=builder /app/apps/communication-service/prisma ./apps/communication-service/prisma
COPY --from=builder /app/packages ./packages

EXPOSE 3005

CMD ["node", "apps/communication-service/dist/server.js"]