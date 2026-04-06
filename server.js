// ============================================================
// Playwright Headless Chrome — Railway Service
// Бесплатная замена Browserless для n8n
//
// POST /content  { "url": "...", "waitForTimeout": 3000 }
// GET  /health   → { "status": "ok" }
// ============================================================

const http = require('http');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3033;

let browser = null;
let requestCount = 0;

// Перезапускаем браузер каждые N запросов (экономия RAM на Railway)
const MAX_REQUESTS_BEFORE_RESTART = 50;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--no-first-run',
        '--disable-features=site-per-process',
      ],
    });
    requestCount = 0;
    console.log('[playwright] Browser launched');
  }
  return browser;
}

async function restartBrowserIfNeeded() {
  requestCount++;
  if (requestCount >= MAX_REQUESTS_BEFORE_RESTART && browser) {
    console.log(`[playwright] Restarting browser after ${requestCount} requests`);
    try { await browser.close(); } catch (e) { /* ignore */ }
    browser = null;
  }
}

async function getPageContent(url, waitForTimeout = 3000) {
  const br = await getBrowser();
  const context = await br.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0',
    locale: 'uk-UA',
    extraHTTPHeaders: {
      'Accept-Language': 'uk-UA,uk;q=0.9,ru-RU;q=0.8,ru;q=0.7,en;q=0.6',
    },
  });

  const page = await context.newPage();

  try {
    // Блокируем тяжёлые ресурсы для скорости
    await page.route('**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf,eot}', (route) =>
      route.abort()
    );
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (
        url.includes('google-analytics') ||
        url.includes('googletagmanager') ||
        url.includes('facebook.net') ||
        url.includes('doubleclick') ||
        url.includes('hotjar')
      ) {
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (waitForTimeout > 0) {
      await page.waitForTimeout(waitForTimeout);
    }

    const html = await page.content();
    return html;
  } finally {
    await context.close();
    await restartBrowserIfNeeded();
  }
}

const server = http.createServer(async (req, res) => {
  // Health-check (Railway uses this)
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', requests: requestCount }));
    return;
  }

  // Main endpoint — Browserless-compatible
  if (req.method === 'POST' && req.url.startsWith('/content')) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { url, waitForTimeout = 3000 } = JSON.parse(body);

        if (!url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "url" in request body' }));
          return;
        }

        console.log(`[#${requestCount + 1}] ${url} (wait: ${waitForTimeout}ms)`);
        const start = Date.now();
        const html = await getPageContent(url, waitForTimeout);
        console.log(`[#${requestCount}] Done in ${Date.now() - start}ms, ${html.length} bytes`);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        console.error('[error]', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[playwright-service] Running on port ${PORT}`);
  console.log(`[playwright-service] POST /content — get rendered HTML`);
  console.log(`[playwright-service] GET  /health  — health check`);
});

process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
