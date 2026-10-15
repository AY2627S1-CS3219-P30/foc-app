# syntax=docker/dockerfile:1
# Multi-stage build for the Next.js web app. Uses Bun, matching the lockfile in
# this folder; the backend services use npm and are built from the repo root.

FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules node_modules
COPY . .
# NEXT_PUBLIC_* values are inlined into the browser bundle by `next build`, so
# they are build args (visible to RUN below); setting them on the running
# container does nothing. A production build without
# NEXT_PUBLIC_USER_SERVICE_URL shows a configuration error on the account
# screens rather than calling localhost.
ARG NEXT_PUBLIC_USER_SERVICE_URL
ARG NEXT_PUBLIC_SUPPLIER_SERVICE_URL
ARG NEXT_PUBLIC_ORDER_SERVICE_URL
ARG NEXT_PUBLIC_CREDIT_SERVICE_URL
ARG NEXT_PUBLIC_DEV_MAILBOX
# The platform dashboard the admin console's Operations tab links to (PLT-05).
ARG NEXT_PUBLIC_GRAFANA_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# ---- runtime ----------------------------------------------------------------
# `output: "standalone"` emits a minimal server plus only the dependencies it
# actually imports, so nothing from the build stage needs to come along.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
