# ─────────────────────────────────────────────
# Stage 1: Builder
# Build context: backend/ (monorepo root)
# ─────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/ ./packages/
COPY apps/payment-service/ ./apps/payment-service/

RUN npm ci --workspace=@futurespark/payment-service --include-workspace-root

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
ENV PAY_DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN cd apps/payment-service && npx prisma generate

# Build the payment-service TypeScript
RUN npm run build -w @futurespark/payment-service

# ─────────────────────────────────────────────
# Stage 2: Production Runner
# ─────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/payment-service/dist ./apps/payment-service/dist
COPY --from=builder /app/apps/payment-service/package.json ./apps/payment-service/package.json
COPY --from=builder /app/apps/payment-service/prisma ./apps/payment-service/prisma
COPY --from=builder /app/packages ./packages

EXPOSE 3004

CMD ["node", "apps/payment-service/dist/server.js"]