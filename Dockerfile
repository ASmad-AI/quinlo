# syntax=docker/dockerfile:1
# Multi-stage build: compile + bundle the Studio, then ship a slim runner.
# Node 20+ required (engines: >=20).

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json branding.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund && npm run build \
  && npm prune --omit=dev

FROM node:20-alpine AS runner
RUN apk add --no-cache git tini
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/branding.json ./branding.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/server/dist/index.js"]
