FROM node:24-alpine AS build
RUN apk add --no-cache openssl libc6-compat && corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm db:generate && pnpm build
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3100
EXPOSE 3100
CMD ["sh", "-c", "if [ \"$APP_ROLE\" = \"worker\" ]; then exec pnpm --filter @orbitdesk/worker start; else exec pnpm --filter @orbitdesk/web start; fi"]
