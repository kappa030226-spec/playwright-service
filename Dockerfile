FROM node:20-slim

# Playwright needs these system deps for Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 libx11-6 \
    libxext6 libxfixes3 libdbus-1-3 libexpat1 libxcb1 \
    fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

# Download only Chromium headless shell (smaller, faster)
RUN npx playwright install chromium

COPY server.js ./

ENV PORT=3033
EXPOSE 3033

CMD ["node", "server.js"]
