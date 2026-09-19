# WebOS — Node 20 + ASLI Chromium (headless shell)
#
# Debian slim isliye: Chromium ke system libs glibc maangte hain (alpine/musl me
# puppeteer ki downloaded build nahi chalti). Image me puppeteer ka
# chrome-headless-shell pehle se download ho jaata hai, to runtime pe kuch
# install karne ki zaroorat nahi — Render ka spin-up fast rehta hai.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    WEBOS_DATA_DIR=/data \
    PUPPETEER_CACHE_DIR=/app/.cache/puppeteer \
    PUPPETEER_SKIP_DOWNLOAD=false \
    WEBOS_CHROMIUM=auto \
    PORT=3000

WORKDIR /app

# ---- Chromium runtime libraries (puppeteer ke official deps list se) ----
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation fonts-noto-color-emoji \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 \
      libcups2 libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 \
      libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
      libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxi6 \
      libxkbcommon0 libxrandr2 libxrender1 wget xdg-utils \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# puppeteer khud apna chrome-headless-shell download karta hai (build ke waqt)
RUN npm install --omit=dev --no-audit --no-fund \
    && npx puppeteer browsers install chrome-headless-shell

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY tools ./tools
COPY README.md AGENT-API.md ./

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
