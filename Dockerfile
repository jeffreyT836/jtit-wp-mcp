FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# node:22-alpine already provides a non-root "node" user (uid 1000).
# /app/data holds the SQLite site store (mount a volume there).
RUN mkdir -p /app/data /app/logs && chown -R node:node /app
USER node

ENV SITES_DB=/app/data/sites.db
# node:sqlite is stable enough for this use but still warns on every start.
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
ENV MCP_TRANSPORT=stdio

EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
