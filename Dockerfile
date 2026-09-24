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
COPY config/sites.example.json ./config/sites.example.json

# node:22-alpine already provides a non-root "node" user (uid 1000).
RUN mkdir -p /app/config /app/logs && chown -R node:node /app
USER node

ENV SITES_CONFIG=/app/config/sites.json
ENV MCP_TRANSPORT=stdio

EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
