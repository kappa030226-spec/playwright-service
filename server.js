// ============================================================
// Playwright Headless Chrome — Railway Service v2
// With request queue to prevent concurrent crashes
// ============================================================

const http = require('http');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3033;

let browser = null;
let requestCount = 0;
const MAX_REQUESTS_BEFORE_RESTART = 100;

// ---- Request Queue ----
// Ensures only one page is processed at a time
const queue = [];
let processing = false;

function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;

  const { task, resolve, reject } = queue.shift();
  try {
    const result = await task();
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    processing = false;
    // Process next item
    if (queue.length > 0) {
      setImmediate(processQueue);
    }
  }
}

// ---- Browser Management ----
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    console.log('[playwright] Launching browser...');
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
    // Block heavy resources for speed
    await page.route('**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf,eot}', (route) =>
      route.abort()
    );
    await page.route('**/*', (route) => {
      const reqUrl = route.request().url();
      if (
        reqUrl.includes('google-analytics') ||
        reqUrl.includes('googletagmanager') ||
        reqUrl.includes('facebook.net') ||
        reqUrl.includes('doubleclick') ||
        reqUrl.includes('hotjar')
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

// ---- HTTP Server ----
const server = http.createServer(async (req, res) => {
  // Health-check
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', requests: requestCount, queue: queue.length }));
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

        console.log(`[queued #${requestCount + 1}] ${url} (wait: ${waitForTimeout}ms) [queue: ${queue.length}]`);
        const start = Date.now();

        // Process through queue — one at a time
        const html = await enqueue(() => getPageContent(url, waitForTimeout));

        console.log(`[done #${requestCount}] ${Date.now() - start}ms, ${html.length} bytes`);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        console.error('[error]', err.message);

        // If browser crashed, reset it for next request
        if (err.message.includes('closed') || err.message.includes('crashed')) {
          try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
          browser = null;
        }

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
  console.log(`[playwright-service] POST /content — get rendered HTML (queued)`);
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
