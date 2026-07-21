# ─────────────────────────────────────────────
# Stage 1: Builder
# Build context: backend/ (monorepo root)
# ─────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace manifests
COPY package.json package-lock.json ./

# Copy all shared packages
COPY packages/ ./packages/

# Copy only the auth-service app
COPY apps/auth-service/ ./apps/auth-service/

# Install all workspace dependencies
RUN npm ci --workspace=@futurespark/auth-service --include-workspace-root

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

# Generate Prisma client (requires AUTH_DATABASE_URL at build time for engine binaries)
# We use a dummy URL here; the real URL is injected at container runtime via env vars
ENV AUTH_DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN cd apps/auth-service && npx prisma generate

# Build the auth-service TypeScript
RUN npm run build -w @futurespark/auth-service

# ─────────────────────────────────────────────
# Stage 2: Production Runner
# ─────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy built artifacts from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/auth-service/dist ./apps/auth-service/dist
COPY --from=builder /app/apps/auth-service/package.json ./apps/auth-service/package.json
COPY --from=builder /app/apps/auth-service/prisma ./apps/auth-service/prisma
COPY --from=builder /app/packages ./packages

EXPOSE 3001

CMD ["node", "apps/auth-service/dist/server.js"]