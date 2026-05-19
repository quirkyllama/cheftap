# Build stage
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install --include=dev
COPY src ./src
RUN npx tsc -p . && npm prune --omit=dev

# Runtime stage: Playwright official image already has Chromium and all OS deps.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY src/public ./dist/public

RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/server.js"]
