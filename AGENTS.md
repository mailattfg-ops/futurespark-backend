# Finquo Junior Backend — Agent Guide

npm workspaces monorepo for **Finquo Junior** — a live online coding-education platform for children. The **gateway** (`apps/gateway`) is the public API entry point: it verifies JWTs, signs internal HMAC headers, and proxies to six downstream services. Four routes are served locally by the gateway (logs, system-health, presence, tech-feed) because only it can reach every service and the log files.

> **Legacy naming:** The product was formerly called "FutureSpark". The npm scope (`@futurespark/*`), repo folder name, and some env/log strings still use that name — do not rename them unless a dedicated migration is planned.

## Product context (read before coding)

**This repo is the backend only** — two separate frontend apps call it through the gateway:

| Frontend | Audience | Typical use |
|----------|----------|-------------|
| **Landing page** | Prospective students/parents | Marketing, course info, **demo-class booking**, lead capture |
| **Dashboard** | Students, parents, tutors (mentors), admins, schedulers | Day-to-day app after signup — classes, curriculum, scheduling, reports |

### User journey

1. **Discovery & demo** — A parent/student visits the landing page and books a **demo class** to try the product and meet a teacher. Backend handles this via **public** gateway routes (no login): `/api/leads`, `/api/pilot-leads`, `/api/partial-leads` → learning-service.
2. **Enrollment** — After the demo, families enroll for full-time learning (payments, onboarding — `/api/payments`, user records in auth-service).
3. **Regular 1-to-1 mentoring** — A **scheduler** assigns recurring **1-to-1** sessions between one tutor and one student. Schedules live in auth-service (`/api/schedules`, `/api/scheduler-groups`); curriculum and session content in learning-service (`/api/courses`).
4. **Live classes** — Tutor and student join the same meeting (Google Meet / Zoom via integration-service) to work through the course. Recordings, presence, and transcription flow through integration + learning services.
5. **Ongoing communication** — Session reminders, progress reports, and WhatsApp notifications go through communication-service.

### Roles agents will see in code

- **STUDENT / PARENT** — attend classes, view progress, reflections
- **MENTOR** (tutor) — teach 1-to-1 sessions, contribute resources
- **SCHEDULER** — book and manage class slots for students
- **ADMIN** — platform configuration, AI settings, logs, system health
- **DISPLAY** — read-only wallboard for a physical display screen (heavily restricted at gateway)

### Implications for backend changes

- **Landing-page traffic** must stay on public routes; do not add JWT auth to lead/demo endpoints unless the product explicitly requires it.
- **Dashboard traffic** goes through authenticated proxies; the gateway signs identity headers that downstream services must verify.
- Features span services — e.g. a "class" ties together auth schedules, learning curriculum, integration meetings, and communication reminders. Check which service owns the data before adding fields or endpoints.
- CORS allows frontend origins (`ALLOWED_ORIGINS`, `*.finquo.ai`, `*.finquojunior.com`, localhost).

## Quick commands

```bash
npm install                  # from repo root
npm run dev                  # all 7 services (concurrently, hot-reload)
npm run start                # all 7 services (compiled dist/)
npm run start:one -w @futurespark/gateway   # single service
npm run build                # shared packages first, then all apps
npm run db:check             # Prisma drift check (all services)
npm run db:sync              # check → push → generate (all services)
npm run db:seed:admin        # seed admin credentials
npm test                     # runs workspace tests if present (none configured today)
```

**No ESLint or Prettier config** in this repo. Verification is build + manual/smoke test.

### Focused verification (after a change)

1. **Shared package change** → `npm run build -w @futurespark/<package>` then rebuild any app that imports it.
2. **Single-service change** → `npm run dev -w @futurespark/<service>` (or `build` + `start` for prod path).
3. **Gateway / routing change** → restart gateway, hit `GET http://localhost:3000/health`, then exercise the affected `/api/*` path.
4. **Prisma schema change** → `npm run db:check`, then `npm run db:sync` (or `--service <name>` for one service).
5. **Full integration** → `npm run dev` from root; confirm all seven processes start and gateway proxies respond.

Build order matters: root `npm run build` compiles `@futurespark/*` packages in dependency order, then all apps. Prisma apps run `prisma generate && tsc`.

## Services & ports

| Service | Workspace | Default port | Env var |
|---------|-----------|--------------|---------|
| Gateway | `@futurespark/gateway` | 3000 | `PORT` |
| Auth | `@futurespark/auth-service` | 3001 | `AUTH_SERVICE_PORT` |
| Learning | `@futurespark/learning-service` | 3002 | `LEARNING_SERVICE_PORT` |
| Communication | `@futurespark/communication-service` | 3003 | `COMMUNICATION_SERVICE_PORT` |
| Payment | `@futurespark/payment-service` | 3004 | `PAYMENT_SERVICE_PORT` |
| Analytics | `@futurespark/analytics-service` | 3005 | `ANALYTICS_SERVICE_PORT` |
| Integration | `@futurespark/integration-service` | 3006 | `INTEGRATION_SERVICE_PORT` |

Inter-service URLs use `*_SERVICE_URL` env vars (e.g. `AUTH_SERVICE_URL`, `LEARN_SERVICE_URL`). Defaults are `http://127.0.0.1:<port>`.

**Payment** and **analytics** are currently health-check stubs (no business routes yet). The gateway still proxies `/api/payments` and pings analytics from system-health.

## Repo layout

```
apps/
  gateway/              # API gateway — proxy + local admin routes
  auth-service/         # Users, roles, schedules, audit
  learning-service/     # Courses, leads, AI admin, transcription, resources
  communication-service/# Notifications, WhatsApp
  integration-service/  # Google/Zoom OAuth, recordings, storage, webhooks
  payment-service/      # Stub
  analytics-service/    # Stub
packages/
  authentication/       # JWT, Redis blocklist, HMAC sign/verify
  middleware/           # asyncHandler, AppError, errorHandler, requestId
  response/             # successResponse / errorResponse envelope
  constants/            # HTTP_STATUS, domain constants, buildInfo
  logger/               # Winston → console + logs/<service>.log
  cache/                # Redis client
  database/, types/, enums/, validators/, utils/, storage/, queue/, events/
scripts/                # db-sync, seed/clean, ops utilities
logs/                   # Per-service log files (read by gateway /api/logs)
.env                    # Single source of truth for all config
```

Each service follows `src/modules/<feature>/` with `*.routes.ts`, controllers, and services. Shared logic lives in `packages/`, not duplicated across apps.

## Architecture

### Request flow

```
Client → Gateway (JWT verify, Redis blocklist, HMAC sign)
       → Downstream service (verifyInternalHeaders / requireVerifiedIdentity)
       → Prisma DB (per-service schema)
```

- **Public routes** (no JWT): `/api/auth/*`, lead forms, OAuth callbacks, Zoom/Google webhooks, recording streams, `/api/whatsapp/webhook`.
- **Protected routes**: `authenticate` middleware verifies Bearer JWT, checks Redis blocklist, injects `x-user-id`, `x-user-role`, `x-internal-signature` headers.
- **Role gates**: `authorize(['ADMIN'])` on some gateway routes; services use `requireRoles()` for finer control.
- **Machine-to-machine**: auth-service paths like `/schedules/internal/*` and `/audit/record` use `x-internal-key` (`INTERNAL_API_KEY`), not user identity.

### Gateway-local routes (not proxied)

| Path | Purpose |
|------|---------|
| `/api/logs` | Merged tail of `logs/*.log` files |
| `/api/system-health` | Fan-out to every service's `/health` and `/metrics` |
| `/api/presence` | Live "who is on the app" from request traffic |
| `/api/tech-feed` | Merged admin dashboard event stream |

### Gateway proxy map (abbreviated)

| Gateway prefix | Target service | Rewritten prefix |
|----------------|----------------|------------------|
| `/api/auth` | auth (3001) | `/auth/` |
| `/api/users`, `/roles`, `/schedules`, `/scheduler-groups`, `/audit` | auth | respective `/users/`, etc. |
| `/api/courses`, `/leads`, `/pilot-leads`, `/partial-leads`, `/ai`, `/resources` | learning (3002) | `/courses/`, etc. |
| `/api/payments` | payment (3004) | `/payments/` |
| `/api/notifications`, `/api/whatsapp/*` | communication (3003) | respective paths |
| `/api/google/*`, `/api/zoom/*`, `/api/storage` | integration (3006) | respective paths |

Path rewrites strip `/api/<segment>` and prepend the service's mount path. See `apps/gateway/src/app.ts` for the full list including public vs auth-gated routes.

### API response shape

All services use `@futurespark/response`:

```json
{ "success": true, "message": "...", "data": { ... }, "timestamp": "..." }
```

Downstream fetches in gateway routes unwrap `body.data`.

## Environment & config

- **One `.env` at repo root.** Every service loads it via `src/load-env.ts` (must be the first import in `server.ts`).
- **Per-service `.env` files are NOT loaded.** If `apps/<service>/.env` exists, a startup warning is printed — move keys to root `.env` and delete the stray file.
- **Never commit `.env`.** It contains production secrets.
- Key groups: `*_DATABASE_URL` (one Postgres, separate schemas per service), `JWT_*`, `INTERNAL_HMAC_KEY`, `INTERNAL_API_KEY`, `REDIS_URL`, `*_SERVICE_URL`, AWS, Google/Zoom OAuth, WhatsApp, Groq/AI tuning vars.

`scripts/db-sync.js` loads root `.env` then optionally overlays a per-service `.env` if present (legacy); runtime services do not.

## Critical gotchas

### Gateway: no body parser

The gateway mounts **no** `express.json()` or `express.urlencoded()`. This is load-bearing for `/api/whatsapp/webhook` — Meta's `X-Hub-Signature-256` is an HMAC over the exact raw bytes. Adding any body parser will break webhook signature verification (hangs or 401s). Do not add one.

### WhatsApp webhook registration order

Nothing may be registered for `/api/whatsapp/webhook` above its proxy middleware in `app.ts`. Express matches in registration order; an earlier handler silently swallows inbound messages while Meta still gets a 200.

### DISPLAY role

JWT role `DISPLAY` is restricted in `authenticate` middleware to read-only GET on `/api/schedules`, `/api/courses`, `/api/google/presence`, `/api/zoom/presence`. Returns **403** (not 401) so display screens don't log themselves out.

### Login throttle

`/api/auth/login` has in-memory rate limiting (20 attempts / 5 min / IP). Per-process only — move to Redis if gateway scales past one instance.

### Auth service identity

`requireVerifiedIdentity` on auth-service verifies gateway HMAC headers on all routes except `/auth/*` and `/health`. Do not bypass this or accept bare `x-user-role` headers.

### Capabilities lists

Auth and learning services expose `build.capabilities` in `/health` responses. Add a capability name in the same commit as the behaviour; never rename existing names (they prove a fix is deployed).

### Prisma

Six services have `prisma/schema.prisma` (auth, learning, communication, integration, payment, analytics). Each uses its own `*_DATABASE_URL` with a Postgres schema (e.g. `schema=auth`). `connection_limit=1` is set — aggregate queries can be slow (~15s cold); system-health uses 25s timeouts.

## Docker

`docker-compose.yml` runs gateway, auth-service, postgres, pgadmin, and redis only. Other services are started via `npm run dev` locally. Each app has a multi-stage `Dockerfile` building from monorepo root context.

## Shared packages — when to edit

| Package | Use for |
|---------|---------|
| `authentication` | JWT, blocklist, HMAC sign/verify, password hashing |
| `middleware` | `asyncHandler`, `AppError`, `errorHandler`, `requestId` |
| `response` | Standard API envelope |
| `constants` | `HTTP_STATUS`, shared domain constants, `buildInfo()` |
| `logger` | Winston logging to console + `logs/<service>.log` |
| `cache` | Redis client (JWT blocklist) |
| `types` / `enums` | Shared TypeScript types |

After editing a package, rebuild it before rebuilding dependent apps.

## Ops scripts (`scripts/`)

| Script | Purpose |
|--------|---------|
| `db-sync.js` | Prisma check/push/generate across services (`--service`, `--check-only`, etc.) |
| `seed-admin-credentials.ts` | Seed admin user (`npm run db:seed:admin`) |
| `clear-data-keep-admin.ts` | Wipe data, keep admin (`npm run db:clean`) |
| `whats-deployed.sh`, `check-ai-config.js`, others | Deployment / ops utilities |

## Conventions for agents

- **Minimize scope.** Match existing module layout (`modules/<feature>/`), naming, and comment style. Inline comments in this codebase explain *why* (security, ordering, production incidents) — preserve that tone when adding load-bearing notes.
- **Gateway changes**: check proxy pathRewrite, auth middleware placement, and whether the route needs raw body passthrough.
- **New protected endpoint**: gateway adds proxy + `authenticate`; downstream service adds route behind `requireInternalAuth` / `requireVerifiedIdentity`.
- **New public endpoint**: explicitly omit `authenticate`; document why in a comment if non-obvious.
- **Do not create per-service `.env` files.**
- **Do not commit secrets** or modify `.env` in PRs.

## Instruction sources

- This file (`AGENTS.md`) — project-wide agent guidance.
- Inline comments in `apps/gateway/src/app.ts`, `load-env.ts`, and auth middleware — authoritative for security-sensitive behaviour.
- No `.cursor/rules/`, Copilot instructions, or GitHub Actions workflows are present in this repo yet.
