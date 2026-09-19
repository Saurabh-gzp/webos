# WebOS — Node 20, zero dependencies
FROM node:20-alpine

ENV NODE_ENV=production
# Where the virtual filesystem lives. Mount a volume here to persist files.
ENV WEBOS_DATA_DIR=/data
WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY tools ./tools
COPY README.md AGENT-API.md ./

RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/ping || exit 1

CMD ["node", "server.js"]
