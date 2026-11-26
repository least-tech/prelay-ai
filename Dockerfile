FROM node:24.22.3-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --offline --no-audit --no-fund
COPY . .
RUN npm run build && mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/relay.sqlite
EXPOSE 3000
CMD ["node", "scripts/container-entry.mjs"]
