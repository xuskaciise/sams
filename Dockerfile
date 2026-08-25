# syntax=docker/dockerfile:1

# ── Stage 1: deps ──────────────────────────────────────────────
# Installs dependencies and generates the Prisma client. Kept
# separate from the build stage so Docker can cache this layer
# whenever only source files change, not package.json.
FROM node:20-alpine AS deps
WORKDIR /app

# argon2 is a native module — needs a C/C++ toolchain to build its
# binding during npm ci. openssl + libc6-compat are required by
# Prisma 6's query engine on Alpine (musl libc).
RUN apk add --no-cache python3 make g++ openssl libc6-compat

# Copy manifest + lockfile first (cache layer), then the prisma/
# folder BEFORE npm ci — @prisma/client's postinstall hook runs
# `prisma generate`, which needs schema.prisma to already be present.
COPY package.json package-lock.json ./
COPY prisma ./prisma

RUN npm ci

# ── Stage 2: builder ───────────────────────────────────────────
# Builds the Next.js app. No DATABASE_URL needed here — the build
# script is now just "prisma generate && next build" (migrate
# deploy runs separately, at deploy time, via its own GitHub
# Actions step against a dedicated container — not from here).
FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ── Stage 3: runner ────────────────────────────────────────────
# Minimal production image: standalone server output only,
# running as a non-root user.
FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Next.js standalone output: a self-contained server.js plus only
# the node_modules it actually traced as needed.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Prisma's native query-engine binary is not reliably picked up by
# Next.js's output file tracing (known Next.js + Prisma standalone
# gap) — copy it in explicitly so `prisma.*` calls don't fail at
# runtime with "Cannot find module '.prisma/client'".
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/client ./node_modules/@prisma/client

USER nextjs

EXPOSE 3000

# node:alpine ships wget via busybox — no extra package needed.
# Nginx/deploy tooling can poll container health via `docker inspect`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
