# syntax=docker/dockerfile:1
# Multi-stage build for credit-service. Produces a small runtime image with no build
# toolchain and no dev dependencies, running as a non-root user (PL-NFR2.1.2).

FROM node:22-alpine AS base
WORKDIR /app

# ---- dependencies -----------------------------------------------------------
# Only the manifests are copied here so this layer is cached until a dependency
# actually changes, not on every source edit.
FROM base AS deps
COPY package.json package-lock.json ./
COPY platform/package.json platform/package.json
COPY credit-service/package.json credit-service/package.json
RUN npm ci

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY platform platform
COPY credit-service credit-service
RUN npm run build -w @foc/platform \
 && npm run build -w @foc/credit-service

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY platform/package.json platform/package.json
COPY credit-service/package.json credit-service/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/platform/dist platform/dist
COPY --from=build /app/credit-service/dist credit-service/dist

# node:22-alpine ships an unprivileged `node` user; never run as root.
USER node
EXPOSE 3004

# Alpine has no curl; use node itself so the image stays small.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3004)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "credit-service/dist/main.js"]
