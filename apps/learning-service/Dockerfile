# ─────────────────────────────────────────────
# Stage 1: Builder
# Build context: backend/ (monorepo root)
# ─────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/ ./packages/
COPY apps/learning-service/ ./apps/learning-service/

RUN npm ci --workspace=@futurespark/learning-service --include-workspace-root

# Build shared packages in dependency order
RUN npm run build -w @futurespark/constants
RUN npm run build -w @futurespark/enums
RUN npm run build -w @futurespark/logger
RUN npm run build -w @futurespark/response
RUN npm run build -w @futurespark/types
RUN npm run build -w @futurespark/authentication
RUN npm run build -w @futurespark/cache
RUN npm run build -w @futurespark/database
RUN npm run build -w @futurespark/middleware
RUN npm run build -w @futurespark/validators
RUN npm run build -w @futurespark/utils

# Generate Prisma client (dummy URL; real URL injected at runtime)
ENV LEARN_DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN cd apps/learning-service && npx prisma generate

# Build the learning-service TypeScript
RUN npm run build -w @futurespark/learning-service

# ─────────────────────────────────────────────
# Stage 2: Production Runner
# ─────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/learning-service/dist ./apps/learning-service/dist
COPY --from=builder /app/apps/learning-service/package.json ./apps/learning-service/package.json
COPY --from=builder /app/apps/learning-service/prisma ./apps/learning-service/prisma
COPY --from=builder /app/packages ./packages

EXPOSE 3002

CMD ["node", "apps/learning-service/dist/server.js"]