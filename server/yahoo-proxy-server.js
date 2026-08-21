
/* ============================================================================
 * Stock Badshah — Minimal Backend Proxy for Yahoo Historical Data
 * ----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS (see YAHOO-HISTORICAL-DATA-TEST-REPORT.md for full
 * detail): a browser can't call Yahoo's chart endpoint directly — Yahoo does
 * not send Access-Control-Allow-Origin for arbitrary origins, so
 * screener.html's own fetch() would be blocked by the browser's CORS policy
 * before the request even reaches Yahoo. A backend-to-backend request has no
 * such restriction (CORS is a browser rule, not a server one) — so the fix
 * is: browser -> our own backend (same-origin) -> Yahoo (server-to-server).
 *
 * STATUS: LOCAL ONLY. This process is not deployed, not exposed to the
 * public internet, and not wired into screener.html in this drop. It is
 * meant to be run on your own machine with `node server/yahoo-proxy-server.js`
 * and hit from curl/Postman/browser at http://localhost while you verify it
 * works. It does NOT touch firebase-config.js, any strategy engine,
 * indicator-math.js, or any HTML page.
 *
 * No live trading / order-placement functionality of any kind lives here —
 * this process only ever reads historical daily OHLCV bars and returns
 * them as JSON. It never fabricates data: a failed upstream fetch is
 * returned as a clear HTTP error with the real error message, never
 * papered over with placeholder numbers.
 *
 * ----------------------------------------------------------------------------
 * ENDPOINTS
 * ----------------------------------------------------------------------------
 *
 *   GET /api/historical?symbol=RELIANCE.NS&range=1y
 *     The primary endpoint.
 *       - symbol   required. Validated against YahooProvider.isValidSymbol()
 *                  (letters/digits/dot/hyphen/ampersand, 1-20 chars). An
 *                  invalid or missing symbol never reaches Yahoo — 400 is
 *                  returned immediately.
 *       - range    optional, defaults to "1y". Any Yahoo-style range string:
 *                  1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max.
 *     Response 200 (normalized JSON):
 *       {
 *         "symbol": "RELIANCE.NS",
 *         "source": "Yahoo Finance historical data",
 *         "range": "1y",
 *         "barCount": 248,
 *         "droppedCount": 0,
 *         "cached": false,
 *         "fetchedAt": "2026-08-20T10:15:00.000Z",
 *         "dailyBars": [
 *           { "date": "2025-08-21", "open": 1402.1, "high": 1415.0,
 *             "low": 1398.5, "close": 1409.75, "volume": 6123456 },
 *           ...
 *         ]
 *       }
 *     No bar is ever invented — dailyBars is exactly what Yahoo returned,
 *     minus any bar with an incomplete OHLCV field (droppedCount says how
 *     many were dropped, never silently).
 *
 *   GET /api/fundamentals?symbol=RELIANCE.NS
 *     New in this drop. Delegates to server/screener-fundamentals-provider.js
 *     (Screener.in scraper — see that file's header for the ToS caveat that
 *     is carried forward, unresolved, by this route). symbol accepts the
 *     ".NS"/".BO" suffix or the bare NSE symbol; the provider strips it.
 *     Response 200 is the flat fundamentals object that provider returns
 *     (pe, pb, industryPe, roe, roce, salesGrowthYoY, profitGrowthYoY,
 *     qoqProfitGrowth, debtToEquity, bookValue, eps, dividendYield,
 *     fundamentalsAsOf, source, sourceUrl) plus "cached": true/false — same
 *     never-fabricate rule as /api/historical: a field the parser can't
 *     find is null, never guessed, and a total failure (Screener.in
 *     down/blocked/layout changed) is a 502 with the real error message,
 *     never a fake fundamentals object.
 *
 *   GET /api/market-data/historical/:symbol?days=250
 *     Kept from the previous drop, UNCHANGED. Enforces the >=250-trading-
 *     day / 200-DMA minimum via YahooProvider.getHistoricalDaily(). No
 *     caching was added to this legacy route so its behavior stays
 *     identical to before.
 *
 * ----------------------------------------------------------------------------
 * CACHING (new in this drop)
 * ----------------------------------------------------------------------------
 * A small in-memory Map caches successful /api/historical responses per
 * (symbol, range) pair for CACHE_TTL_MS (default 5 minutes — configurable
 * via the optional CACHE_TTL_MS env var). This only avoids *redundant*
 * repeated calls to Yahoo within that window; it never returns stale data
 * as if it were fresh — the response always says "cached": true/false and
 * carries the original "fetchedAt" timestamp so the caller can tell.
 * The cache is purely in-process memory: it is empty on every server
 * restart, holds no files, and is never treated as a source of truth if a
 * fresh fetch is requested (there's no "force refresh" needed because a
 * failed cache entry is never stored — only genuine successful Yahoo
 * responses are cached).
 *
 * ----------------------------------------------------------------------------
 * RUNNING IT LOCALLY
 * ----------------------------------------------------------------------------
 *   node server/yahoo-proxy-server.js
 *   curl "http://localhost:8787/api/historical?symbol=RELIANCE.NS&range=1y"
 *
 * No environment variables are required. Optional:
 *   PORT           - port to listen on (default 8787)
 *   CACHE_TTL_MS    - cache lifetime in ms (default 300000 = 5 minutes)
 * ==========================================================================*/

"use strict";

const http = require("http");
const { URL } = require("url");
const YahooProvider = require("../providers/yahoo-provider.js");
const ScreenerFundamentalsProvider = require("./screener-fundamentals-provider.js");

const PORT = process.env.PORT || 8787;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000; // 5 minutes
// Fundamentals move much slower than daily bars (quarterly-lag data), so a
// longer TTL than the historical cache is safe here — same reasoning
// market-data-service.js already applies client-side
// (CONFIG.cache.fundamentalsTtlMs = 24h). Separate Map + separate env var
// on purpose: this cache must never be confused with historicalCache's
// entries, since the two hold differently-shaped bodies.
const FUNDAMENTALS_CACHE_TTL_MS =
  Number(process.env.FUNDAMENTALS_CACHE_TTL_MS) || 24 * 60 * 60 * 1000; // 24 hours

// Same-origin-with-the-frontend deployment needs no CORS headers at all.
// This header is included only so the proxy is also usable during local
// dev when the frontend is served from a different port — remove it in a
// same-origin production deployment. It does not open this server to the
// public internet by itself; that still requires deliberately deploying
// and exposing this process, which is explicitly NOT done in this drop.
const DEV_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// ----------------------------------------------------------------------------
// In-memory cache: key "SYMBOL|range" -> { body, expiresAt }
// Only ever populated with genuine successful Yahoo responses.
// ----------------------------------------------------------------------------
const historicalCache = new Map();

function cacheKey(symbol, range) {
  return `${symbol.toUpperCase()}|${range}`;
}

function getCached(symbol, range) {
  const entry = historicalCache.get(cacheKey(symbol, range));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    historicalCache.delete(cacheKey(symbol, range));
    return null;
  }
  return entry.body;
}

function setCached(symbol, range, body) {
  historicalCache.set(cacheKey(symbol, range), {
    body,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// ----------------------------------------------------------------------------
// In-memory cache for /api/fundamentals: key "SYMBOL" -> { body, expiresAt }
// Only ever populated with a genuine successful Screener.in parse — a
// failed fetch (see handleFundamentals below) is never cached, same rule
// as historicalCache above.
// ----------------------------------------------------------------------------
const fundamentalsCache = new Map();

function getCachedFundamentals(symbol) {
  const entry = fundamentalsCache.get(symbol.toUpperCase());
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    fundamentalsCache.delete(symbol.toUpperCase());
    return null;
  }
  return entry.body;
}

function setCachedFundamentals(symbol, body) {
  fundamentalsCache.set(symbol.toUpperCase(), {
    body,
    expiresAt: Date.now() + FUNDAMENTALS_CACHE_TTL_MS,
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * GET /api/historical?symbol=RELIANCE.NS&range=1y
 */
async function handleHistorical(url, res) {
  const rawSymbol = (url.searchParams.get("symbol") || "").trim();
  const rawRange = (url.searchParams.get("range") || "1y").trim();

  // --- 1. Validate the symbol ---------------------------------------------
  if (!rawSymbol) {
    sendJson(res, 400, {
      error: "invalid_request",
      message: "Missing required query param: symbol (e.g. ?symbol=RELIANCE.NS)",
    });
    return;
  }
  if (!YahooProvider.isValidSymbol(rawSymbol)) {
    sendJson(res, 400, {
      error: "invalid_symbol",
      message: `"${rawSymbol}" is not a valid symbol. Expected letters/digits/dot/hyphen/ampersand only, e.g. RELIANCE.NS.`,
    });
    return;
  }
  const symbol = rawSymbol.toUpperCase();

  // --- 2. Serve from cache if we have a fresh entry -----------------------
  const cached = getCached(symbol, rawRange);
  if (cached) {
    sendJson(res, 200, { ...cached, cached: true });
    return;
  }

  // --- 3. Fetch server-to-server from Yahoo, normalize, cache, respond ---
  try {
    const { bars, range: usedRange, droppedCount } =
      await YahooProvider.getHistoricalDailyByRange(symbol, rawRange);

    const body = {
      symbol,
      source: "Yahoo Finance historical data",
      range: usedRange,
      barCount: bars.length,
      droppedCount,
      fetchedAt: new Date().toISOString(),
      dailyBars: bars,
    };

    setCached(symbol, rawRange, body);
    sendJson(res, 200, { ...body, cached: false });
  } catch (err) {
    // --- 4. Handle Yahoo/network errors safely, never fake data ----------
    console.error(`[yahoo-proxy-server] /api/historical "${symbol}" (range=${rawRange}) failed:`, err.message);
    sendJson(res, 502, {
      error: "upstream_fetch_failed",
      message: err.message,
    });
  }
}

/**
 * GET /api/fundamentals?symbol=RELIANCE.NS
 * New in this drop. Delegates entirely to
 * ScreenerFundamentalsProvider.getFundamentals() (server/screener-
 * fundamentals-provider.js) — this route does no parsing itself, only
 * validation, caching, and error-shaping, mirroring handleHistorical()
 * above so browser-data-provider.js's existing fetchJson() call (it
 * already hits this exact path — see providers/browser-data-provider.js)
 * gets the response shape it expects.
 *
 * On failure (Screener.in down/blocked/layout changed, or ToS/network
 * issues) this returns a normal 502 with { error, message } — it never
 * fabricates a fundamentals object. browser-data-provider.js already
 * catches that and degrades to `{}` so a fundamentals outage never breaks
 * price/technical data.
 */
async function handleFundamentals(url, res) {
  const rawSymbol = (url.searchParams.get("symbol") || "").trim();

  if (!rawSymbol) {
    sendJson(res, 400, {
      error: "invalid_request",
      message: "Missing required query param: symbol (e.g. ?symbol=RELIANCE.NS)",
    });
    return;
  }

  const cached = getCachedFundamentals(rawSymbol);
  if (cached) {
    sendJson(res, 200, { ...cached, cached: true });
    return;
  }

  try {
    const fundamentals = await ScreenerFundamentalsProvider.getFundamentals(rawSymbol);
    setCachedFundamentals(rawSymbol, fundamentals);
    sendJson(res, 200, { ...fundamentals, cached: false });
  } catch (err) {
    console.error(`[yahoo-proxy-server] /api/fundamentals "${rawSymbol}" failed:`, err.message);
    sendJson(res, 502, {
      error: "upstream_fetch_failed",
      message: err.message,
    });
  }
}

/**
 * GET /api/market-data/historical/:symbol?days=250
 * Kept from the previous drop, unchanged behavior (no caching added here).
 */
async function handleMarketDataHistorical(symbol, url, res) {
  const days = Number(url.searchParams.get("days")) || 250;

  try {
    const dailyBars = await YahooProvider.getHistoricalDaily(symbol, days);
    sendJson(res, 200, {
      symbol,
      source: "Yahoo Finance historical data",
      barCount: dailyBars.length,
      dailyBars,
    });
  } catch (err) {
    console.error(`[yahoo-proxy-server] /api/market-data/historical "${symbol}" failed:`, err.message);
    sendJson(res, 502, { error: "upstream_fetch_failed", message: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch (e) {
    sendJson(res, 400, { error: "invalid_request", message: "Malformed request URL." });
    return;
  }

  Object.entries(DEV_CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed", message: "Only GET is supported on this endpoint." });
    return;
  }

  try {
    if (url.pathname === "/api/historical") {
      await handleHistorical(url, res);
      return;
    }

    if (url.pathname === "/api/fundamentals") {
      await handleFundamentals(url, res);
      return;
    }

    const legacyMatch = url.pathname.match(/^\/api\/market-data\/historical\/([^/]+)$/);
    if (legacyMatch) {
      await handleMarketDataHistorical(decodeURIComponent(legacyMatch[1]), url, res);
      return;
    }

    sendJson(res, 404, {
      error: "not_found",
      message: "Route not found. Try /api/historical?symbol=SYMBOL&range=1y",
    });
  } catch (unexpectedErr) {
    // Last-resort safety net — should not normally trigger, since both
    // handlers already catch their own errors. Never leaks a stack trace
    // to the client, never fabricates a body.
    console.error("[yahoo-proxy-server] Unexpected server error:", unexpectedErr);
    sendJson(res, 500, { error: "internal_error", message: "Unexpected server error." });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[yahoo-proxy-server] listening on http://localhost:${PORT}`);
    console.log(`  Try: http://localhost:${PORT}/api/historical?symbol=RELIANCE.NS&range=1y`);
    console.log(`  Try: http://localhost:${PORT}/api/fundamentals?symbol=RELIANCE.NS`);
    console.log(`  Historical cache TTL: ${CACHE_TTL_MS}ms, Fundamentals cache TTL: ${FUNDAMENTALS_CACHE_TTL_MS}ms`);
  });
}

module.exports = server;
