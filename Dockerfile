# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --strict-ssl=true
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 YANDEX_TOKEN_FILE=/data/tokens.json
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["http"]
