// ============================================================
// Playwright Headless Chrome — Railway Service v3
// Mutex lock + auto-retry on crash
// ============================================================

const http = require('http');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3033;
const MAX_RETRIES = 2;

let browser = null;
let requestCount = 0;

// ---- Mutex: only one request at a time ----
let locked = false;
const waiters = [];

function acquireLock() {
  return new Promise((resolve) => {
    if (!locked) {
      locked = true;
      resolve();
    } else {
      waiters.push(resolve);
    }
  });
}

function releaseLock() {
  if (waiters.length > 0) {
    const next = waiters.shift();
    next();
  } else {
    locked = false;
  }
}

// ---- Browser Management ----
async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  
  // Kill old one if exists
  if (browser) {
    try { await browser.close(); } catch (e) { /* ignore */ }
    browser = null;
  }

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
  console.log('[playwright] Browser ready');
  return browser;
}

async function killBrowser() {
  if (browser) {
    try { await browser.close(); } catch (e) { /* ignore */ }
    browser = null;
  }
}

// ---- Fetch page (single attempt) ----
async function fetchPage(url, waitForTimeout) {
  const br = await ensureBrowser();
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
    // Block images & trackers
    await page.route('**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf,eot}', (route) =>
      route.abort()
    );
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (
        u.includes('google-analytics') ||
        u.includes('googletagmanager') ||
        u.includes('facebook.net') ||
        u.includes('doubleclick') ||
        u.includes('hotjar')
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
    requestCount++;
    return html;
  } finally {
    try { await context.close(); } catch (e) { /* ignore */ }
  }
}

// ---- Fetch with retry ----
async function getPageContent(url, waitForTimeout = 3000) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fetchPage(url, waitForTimeout);
    } catch (err) {
      lastError = err;
      console.error(`[attempt ${attempt}/${MAX_RETRIES}] Error: ${err.message}`);
      
      // Kill browser so next attempt gets a fresh one
      await killBrowser();
      
      if (attempt < MAX_RETRIES) {
        console.log('[retry] Restarting browser...');
        // Small delay before retry
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  throw lastError;
}

// ---- HTTP Server ----
const server = http.createServer(async (req, res) => {
  // Health-check
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      requests: requestCount,
      waiting: waiters.length,
      locked,
    }));
    return;
  }

  // Main endpoint
  if (req.method === 'POST' && req.url.startsWith('/content')) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      let url;
      try {
        const parsed = JSON.parse(body);
        url = parsed.url;
        const waitForTimeout = parsed.waitForTimeout ?? 3000;

        if (!url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "url"' }));
          return;
        }

        console.log(`[#${requestCount + 1}] WAIT (queue: ${waiters.length}) ${url}`);

        // Lock — only one request processed at a time
        await acquireLock();

        try {
          const start = Date.now();
          const html = await getPageContent(url, waitForTimeout);
          const ms = Date.now() - start;
          console.log(`[#${requestCount}] OK ${ms}ms ${html.length}b ${url}`);

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } finally {
          releaseLock();
        }

      } catch (err) {
        console.error(`[FAIL] ${url || '?'} — ${err.message}`);
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
  console.log(`[playwright-service v3] port ${PORT}`);
  console.log(`  POST /content  — rendered HTML (mutex + retry)`);
  console.log(`  GET  /health   — status`);
});

process.on('SIGINT', async () => { await killBrowser(); process.exit(0); });
process.on('SIGTERM', async () => { await killBrowser(); process.exit(0); });
