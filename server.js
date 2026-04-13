// ============================================================
// Playwright Headless Chrome — Railway Service v4
// Handles AWS WAF challenge + navigation redirects
// ============================================================

const http = require('http');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3033;
const MAX_RETRIES = 3;

let browser = null;
let requestCount = 0;

// ---- Mutex ----
let locked = false;
const waiters = [];

function acquireLock() {
  return new Promise((resolve) => {
    if (!locked) { locked = true; resolve(); }
    else { waiters.push(resolve); }
  });
}

function releaseLock() {
  if (waiters.length > 0) { waiters.shift()(); }
  else { locked = false; }
}

// ---- Browser ----
async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (browser) { try { await browser.close(); } catch (e) {} browser = null; }

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
      '--no-first-run',
    ],
  });
  requestCount = 0;
  console.log('[playwright] Browser ready');
  return browser;
}

async function killBrowser() {
  if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
}

// ---- Fetch page (single attempt) ----
async function fetchPage(url, waitForTimeout) {
  const br = await ensureBrowser();
  const context = await br.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'uk-UA',
    extraHTTPHeaders: {
      'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
    javaScriptEnabled: true,
  });

  const page = await context.newPage();

  try {
    // Block images & trackers for speed (but NOT scripts — needed for WAF)
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

    // Go to URL — wait for initial load
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait for network to settle (handles WAF challenge redirects)
    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch (e) {
      // networkidle timeout is ok, page might still be usable
      console.log(`[warn] networkidle timeout for ${url}, continuing...`);
    }

    // Additional wait for JS rendering
    if (waitForTimeout > 0) {
      await page.waitForTimeout(waitForTimeout);
    }

    // Check if we got a WAF challenge page
    const title = await page.title();
    const pageUrl = page.url();
    
    if (title === '' || title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('attention')) {
      // WAF challenge detected — wait more for it to resolve
      console.log(`[waf] Challenge detected, waiting extra 5s...`);
      await page.waitForTimeout(5000);
      
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch (e) { /* ok */ }
    }

    // If page navigated (WAF redirect), wait for final page
    if (page.url() !== url) {
      console.log(`[redirect] ${url} → ${page.url()}`);
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
        await page.waitForTimeout(2000);
      } catch (e) { /* ok */ }
    }

    const html = await page.content();
    requestCount++;
    return html;

  } finally {
    try { await context.close(); } catch (e) {}
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
      console.error(`[attempt ${attempt}/${MAX_RETRIES}] ${err.message}`);
      await killBrowser();
      if (attempt < MAX_RETRIES) {
        const delay = attempt * 2000;
        console.log(`[retry] Waiting ${delay}ms before retry...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

// ---- HTTP Server ----
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', v: 4, requests: requestCount, waiting: waiters.length }));
    return;
  }

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

        console.log(`[#${requestCount + 1}] WAIT(${waiters.length}) ${url}`);

        await acquireLock();
        try {
          const start = Date.now();
          const html = await getPageContent(url, waitForTimeout);
          console.log(`[#${requestCount}] OK ${Date.now() - start}ms ${html.length}b`);
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
  console.log(`[playwright-service v4] port ${PORT}`);
});

process.on('SIGINT', async () => { await killBrowser(); process.exit(0); });
process.on('SIGTERM', async () => { await killBrowser(); process.exit(0); });
