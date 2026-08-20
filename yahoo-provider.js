/* ============================================================================
 * Stock Badshah — Yahoo Finance Historical Data Provider
 * ----------------------------------------------------------------------------
 * SCOPE — read before wiring anywhere:
 *   - HISTORICAL DAILY OHLCV ONLY. getHistoricalDaily()/getHistoricalDailyByRange()
 *     are the real implementations. getQuote() derives a "quote" purely from
 *     the most recent daily bar in that same historical series (previous
 *     day's close/OHLCV) — it is explicitly NOT live/real-time data, and
 *     every field it returns is stamped with the historical bar's own date,
 *     not "now", so nothing here can be mistaken for a live tick.
 *   - getFundamentals() is intentionally a no-op stub (resolves to `{}`).
 *     Fundamentals are out of scope — this stub exists only so
 *     MarketDataService.fetchSnapshot() (which always calls all three
 *     provider methods) doesn't throw; it fetches nothing and fabricates
 *     nothing.
 *   - This file is Node/server-side ONLY. It uses Node's built-in global
 *     `fetch` (Node 18+). It is NOT loaded by screener.html, index.html, or
 *     any other browser page, and it is NOT registered into the
 *     MarketDataService singleton that screener.html loads — see
 *     YAHOO-HISTORICAL-DATA-TEST-REPORT.md for exactly why (browser CORS)
 *     and what a real deployment needs (a backend proxy — see
 *     server/yahoo-proxy-server.js in this same drop).
 *   - Does NOT modify market-data-service.js, indicator-math.js, any
 *     strategy engine, or any HTML page.
 *   - This backend is for LOCAL USE ONLY at this stage. It is not deployed
 *     or exposed to the public internet by anything in this drop.
 *
 * CHANGE LOG:
 *   - getQuote(), getHistoricalDaily(), getFundamentals() are UNCHANGED from
 *     the original test drop (still used as-is by test-yahoo-historical-data.js,
 *     which enforces its own >=250-trading-day requirement).
 *   - getHistoricalDailyByRange(symbol, range) — added previously for the
 *     GET /api/historical endpoint. It does not enforce the 250-day/
 *     200-DMA minimum, because a caller of a generic historical-data API is
 *     explicitly allowed to ask for a shorter window (e.g. range=1mo).
 *   - NEW (this drop): isValidSymbol(symbol) — a shared validation helper.
 *     The proxy server calls this before doing any network work, so a
 *     malformed/garbage `symbol` query param is rejected with a clean 400
 *     instead of being sent to Yahoo. getHistoricalDailyByRange() also
 *     calls it internally as a defense-in-depth backstop, in case this
 *     provider is ever called directly by something other than the proxy
 *     server.
 * ==========================================================================*/

"use strict";

const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

// Yahoo's endpoint is known to reject requests with no/robotic User-Agent
// headers (see e.g. community write-ups on the v8 chart endpoint). This is
// a plain, real browser UA string — not a spoofing/evasion trick, just what
// every documented working example of this endpoint uses.
const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  Accept: "application/json",
};

const MIN_TRADING_DAYS = 250; // used only by getHistoricalDaily() (unchanged behavior)

// Ranges Yahoo's v8 chart endpoint actually accepts. Anything else falls
// back to "1y" rather than sending an unvalidated string straight to Yahoo.
const VALID_RANGES = new Set([
  "1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max",
]);

// NSE/BSE-style symbols: letters, digits, dot, hyphen, ampersand
// (covers e.g. RELIANCE.NS, TCS.NS, INFY.NS, M&M.NS, BAJAJ-AUTO.NS).
// Deliberately conservative — this is a security boundary (the value is
// interpolated into a URL sent server-to-server to Yahoo), not just a
// friendliness check.
const SYMBOL_REGEX = /^[A-Za-z0-9.&-]{1,20}$/;

function isValidSymbol(symbol) {
  return typeof symbol === "string" && SYMBOL_REGEX.test(symbol.trim());
}

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Converts a Yahoo v8 chart API JSON response into DailyBar[] — the exact
 * shape market-data-service.js's StockDataSnapshot.dailyBars documents:
 * { date, open, high, low, close, volume }, oldest -> newest. Bars with any
 * null/non-numeric OHLC field (Yahoo emits these for gaps/holidays inside
 * the requested range) are dropped rather than guessed at.
 */
function parseChartResponseToDailyBars(json, symbol) {
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) {
    const err =
      json && json.chart && json.chart.error && json.chart.error.description;
    throw new Error(
      `[YahooProvider] Yahoo returned no chart result for "${symbol}"` +
        (err ? ` — ${err}` : " (empty/unexpected response shape).")
    );
  }

  const timestamps = result.timestamp || [];
  const quote =
    (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const { open = [], high = [], low = [], close = [], volume = [] } = quote;

  const bars = [];
  let droppedCount = 0;

  for (let i = 0; i < timestamps.length; i++) {
    const o = open[i];
    const h = high[i];
    const l = low[i];
    const c = close[i];
    const v = volume[i];

    if (
      !isFiniteNumber(o) ||
      !isFiniteNumber(h) ||
      !isFiniteNumber(l) ||
      !isFiniteNumber(c) ||
      !isFiniteNumber(v)
    ) {
      droppedCount++;
      continue; // never fabricate a missing OHLCV field
    }

    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    bars.push({ date, open: o, high: h, low: l, close: c, volume: v });
  }

  return { bars, droppedCount, meta: result.meta || null };
}

async function fetchChartJson(symbol, range) {
  const url = `${YAHOO_CHART_BASE}/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  let response;
  try {
    response = await fetch(url, { headers: REQUEST_HEADERS });
  } catch (networkErr) {
    // Network-level failure (DNS, TLS, connection refused, egress blocked,
    // timeout, ...). Re-thrown with the symbol/url attached, never swallowed.
    throw new Error(
      `[YahooProvider] Network request to Yahoo failed for "${symbol}" (${url}): ${networkErr.message}`
    );
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `[YahooProvider] Yahoo responded HTTP ${response.status} ${response.statusText} for "${symbol}" ` +
        `(${url})${bodyText ? ` — body: ${bodyText.slice(0, 300)}` : ""}`
    );
  }

  try {
    return await response.json();
  } catch (parseErr) {
    throw new Error(
      `[YahooProvider] Failed to parse Yahoo's response as JSON for "${symbol}": ${parseErr.message}`
    );
  }
}

const YahooProvider = {
  id: "yahoo-finance-historical",

  /** Shared symbol-format validator (see CHANGE LOG above). */
  isValidSymbol,

  /**
   * UNCHANGED. Derives a "quote" purely from the most recent bar of the
   * daily historical series — NOT a live/real-time quote. asOf is the date
   * of that last daily bar, not "now".
   */
  async getQuote(symbol) {
    const json = await fetchChartJson(symbol, "1y");
    const { bars } = parseChartResponseToDailyBars(json, symbol);
    if (bars.length === 0) {
      throw new Error(`[YahooProvider] No usable daily bars returned for "${symbol}" — cannot derive a quote.`);
    }
    const last = bars[bars.length - 1];
    const prev = bars.length > 1 ? bars[bars.length - 2] : null;
    return {
      lastPrice: last.close,
      open: last.open,
      high: last.high,
      low: last.low,
      previousClose: prev ? prev.close : null,
      volumeToday: last.volume,
      marketCap: null, // needs shares outstanding — out of scope (fundamentals excluded)
      asOf: last.date, // last daily bar's date — historical, not live
    };
  },

  /**
   * UNCHANGED. Fetches >= MIN_TRADING_DAYS of daily OHLCV bars, oldest ->
   * newest, dropping (never guessing) any bar with an incomplete field.
   * Still used as-is by test-yahoo-historical-data.js.
   */
  async getHistoricalDaily(symbol, days) {
    const wanted = Math.max(days || MIN_TRADING_DAYS, MIN_TRADING_DAYS);
    const json = await fetchChartJson(symbol, "2y");
    const { bars, droppedCount } = parseChartResponseToDailyBars(json, symbol);

    if (droppedCount > 0) {
      console.warn(
        `[YahooProvider] "${symbol}": dropped ${droppedCount} bar(s) with incomplete OHLCV fields (not guessed, not included).`
      );
    }

    if (bars.length < MIN_TRADING_DAYS) {
      throw new Error(
        `[YahooProvider] Only ${bars.length} usable trading days available for "${symbol}", ` +
          `need at least ${MIN_TRADING_DAYS} for a 200-DMA. Not returning a short/padded series.`
      );
    }

    return bars.slice(Math.max(0, bars.length - wanted));
  },

  /**
   * Fetches daily OHLCV bars for an arbitrary Yahoo-style range string
   * (e.g. "1mo", "3mo", "6mo", "1y", "2y", "5y", "max"), oldest -> newest,
   * dropping (never guessing) any incomplete bar. Unlike getHistoricalDaily(),
   * this does NOT enforce a 250-day minimum. Validates the symbol format
   * itself as a backstop (the proxy server also validates before calling
   * this, so a bad symbol should never reach here in normal operation).
   */
  async getHistoricalDailyByRange(symbol, range) {
    if (!isValidSymbol(symbol)) {
      throw new Error(`[YahooProvider] Invalid symbol format: "${symbol}"`);
    }
    const safeRange = VALID_RANGES.has(range) ? range : "1y";
    const json = await fetchChartJson(symbol, safeRange);
    const { bars, droppedCount } = parseChartResponseToDailyBars(json, symbol);

    if (droppedCount > 0) {
      console.warn(
        `[YahooProvider] "${symbol}" (range=${safeRange}): dropped ${droppedCount} bar(s) with incomplete OHLCV fields (not guessed, not included).`
      );
    }

    if (bars.length === 0) {
      throw new Error(
        `[YahooProvider] No usable daily bars returned for "${symbol}" in range "${safeRange}".`
      );
    }

    return { bars, range: safeRange, droppedCount };
  },

  /**
   * UNCHANGED. Explicitly out of scope. Resolves to an empty object —
   * MarketDataService.fetchSnapshot() merges it in, leaving every
   * fundamentals field null. No fundamentals field is ever fabricated.
   */
  async getFundamentals(_symbol) {
    return {};
  },
};

if (typeof module === "object" && module.exports) {
  module.exports = YahooProvider;
}
