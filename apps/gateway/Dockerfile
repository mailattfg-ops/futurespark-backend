# ─────────────────────────────────────────────
# Stage 1: Builder
# Build context: backend/ (monorepo root)
# ─────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies for the entire workspace so shared packages resolve
COPY package.json package-lock.json ./

# Copy all shared packages first
COPY packages/ ./packages/

# Copy only the gateway app (not all apps — keeps build lean)
COPY apps/gateway/ ./apps/gateway/

# Install all workspace dependencies (hoisted to root node_modules)
RUN npm ci --workspace=@futurespark/gateway --include-workspace-root

# Build shared packages that gateway depends on (in dependency order)
RUN npm run build -w @futurespark/constants
RUN npm run build -w @futurespark/enums
RUN npm run build -w @futurespark/logger
RUN npm run build -w @futurespark/response
RUN npm run build -w @futurespark/types
RUN npm run build -w @futurespark/authentication
RUN npm run build -w @futurespark/cache
RUN npm run build -w @futurespark/middleware

# Build the gateway itself
RUN npm run build -w @futurespark/gateway

# ─────────────────────────────────────────────
# Stage 2: Production Runner
# Lean image — no TypeScript, no devDependencies
# ─────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy built output from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=builder /app/apps/gateway/package.json ./apps/gateway/package.json
COPY --from=builder /app/packages ./packages

# Expose the gateway port
EXPOSE 3000

# Run the compiled server (NOT ts-node-dev)
CMD ["node", "apps/gateway/dist/server.js"]