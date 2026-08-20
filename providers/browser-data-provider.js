/* ============================================================================
 * Stock Badshah — Browser-Safe Data Provider (talks to OUR proxy, not Yahoo)
 * ----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *   yahoo-provider.js (in this same providers/ folder) is Node/server-only —
 *   it calls Yahoo directly and, per YAHOO-HISTORICAL-DATA-TEST-REPORT.md
 *   §3b, that call is blocked by the BROWSER's own CORS policy if it's ever
 *   run inside screener.html or index.html. That is a browser security rule,
 *   not a bug, and it cannot be worked around from client-side JS alone.
 *
 *   This file is the other half of that report's proposed fix (§4): a
 *   DataProvider implementation that is safe to load in the browser because
 *   it never talks to Yahoo itself. It only ever calls OUR OWN backend —
 *   server/yahoo-proxy-server.js, deployed somewhere reachable (Render,
 *   Railway, Cloud Run, etc. — see DEPLOYMENT-GUIDE.md) — which is a
 *   same-origin-or-CORS-enabled request the browser allows, and which then
 *   does the actual Yahoo call server-to-server on our behalf.
 *
 *   Browser (screener.html)
 *      -> BrowserDataProvider (this file)
 *      -> fetch(deployedProxyUrl + '/api/...')      <- browser is fine with this
 *      -> server/yahoo-proxy-server.js
 *      -> fetch('https://query1.finance.yahoo.com/...')  <- server-to-server, no CORS
 *
 * WHAT THIS FILE DOES NOT DO
 *   - Does not talk to Yahoo (or any vendor) directly. Ever.
 *   - Does not hardcode a deployed URL. baseUrl is passed in by whoever
 *     creates the provider (see market-data-config.js) — this file has no
 *     idea where it's deployed, so there's nothing to accidentally leak or
 *     point at the wrong place by default.
 *   - Does not fabricate a quote or a bar. Every failure (proxy down, proxy
 *     not yet deployed, Yahoo itself failing upstream) surfaces as a
 *     rejected Promise with the real error message from the proxy — the
 *     same "never paper over a failure" rule every other provider in this
 *     project follows.
 *   - Does not implement getFundamentals() for real — the proxy has no
 *     fundamentals endpoint yet (out of scope, same as yahoo-provider.js).
 *     Resolves to `{}` so MarketDataService.fetchSnapshot() doesn't throw;
 *     every fundamentals field on the resulting snapshot stays null.
 *   - Does not change market-data-service.js, indicator-math.js, any
 *     strategy engine, or any HTML page's markup. It is registered from the
 *     outside via MarketDataService.registerProvider() — see
 *     market-data-config.js, which is the only place that calls that.
 *
 * USAGE (see market-data-config.js for the actual wiring)
 *   const provider = BrowserDataProvider.create({ baseUrl: "https://your-proxy.onrender.com" });
 *   MarketDataService.registerProvider(provider);
 * ==========================================================================*/

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BrowserDataProvider = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Same validation rule as providers/yahoo-provider.js's isValidSymbol().
  // Duplicated (not imported) on purpose: this file must be loadable by
  // itself via a plain <script> tag in the browser, with no bundler and no
  // access to yahoo-provider.js (which is Node-only and never shipped to
  // the browser).
  const SYMBOL_REGEX = /^[A-Za-z0-9.&-]{1,20}$/;

  function isValidSymbol(symbol) {
    return typeof symbol === "string" && SYMBOL_REGEX.test(symbol.trim());
  }

  function isFiniteNumber(n) {
    return typeof n === "number" && Number.isFinite(n);
  }

  /**
   * Thin fetch wrapper: builds `${baseUrl}${path}`, parses JSON, and turns
   * a non-OK response into a real Error using the proxy's own error body
   * (see server/yahoo-proxy-server.js — it always returns
   * { error, message } on failure) rather than a generic "fetch failed".
   */
  async function fetchJson(baseUrl, path) {
    if (!baseUrl) {
      throw new Error(
        "[BrowserDataProvider] No baseUrl configured — pass { baseUrl } to BrowserDataProvider.create(). " +
          "See market-data-config.js / DEPLOYMENT-GUIDE.md."
      );
    }
    const url = baseUrl.replace(/\/+$/, "") + path;
    let response;
    try {
      response = await fetch(url);
    } catch (networkErr) {
      throw new Error(
        `[BrowserDataProvider] Network request to the proxy failed (${url}): ${networkErr.message}. ` +
          "Is server/yahoo-proxy-server.js actually deployed and reachable at this baseUrl?"
      );
    }

    let body = null;
    try {
      body = await response.json();
    } catch (parseErr) {
      throw new Error(
        `[BrowserDataProvider] Proxy response at ${url} was not valid JSON (HTTP ${response.status}).`
      );
    }

    if (!response.ok) {
      const msg = (body && (body.message || body.error)) || `HTTP ${response.status}`;
      throw new Error(`[BrowserDataProvider] Proxy returned an error for ${url}: ${msg}`);
    }

    return body;
  }

  /**
   * Builds a DataProvider bound to one deployed proxy base URL.
   * Matches the same `interface DataProvider` documented at the top of
   * market-data-service.js — { id, getQuote, getHistoricalDaily, getFundamentals }.
   */
  function create(options) {
    const opts = options || {};
    const baseUrl = (opts.baseUrl || "").trim();

    return {
      id: "browser-proxy-backend",

      /**
       * Derives a quote from a short recent window of daily bars (same
       * "last bar = quote" honesty rule as yahoo-provider.js's getQuote —
       * NOT live/real-time, and asOf is stamped with that bar's own date,
       * never "now"). Uses /api/historical?range=5d so this stays a small,
       * fast request distinct from the full historical fetch below.
       */
      async getQuote(symbol) {
        if (!isValidSymbol(symbol)) {
          throw new Error(`[BrowserDataProvider] Invalid symbol format: "${symbol}"`);
        }
        const body = await fetchJson(
          baseUrl,
          `/api/historical?symbol=${encodeURIComponent(symbol)}&range=5d`
        );
        const bars = body.dailyBars || [];
        if (bars.length === 0) {
          throw new Error(`[BrowserDataProvider] Proxy returned no usable bars for "${symbol}" — cannot derive a quote.`);
        }
        const last = bars[bars.length - 1];
        const prev = bars.length > 1 ? bars[bars.length - 2] : null;
        return {
          lastPrice: isFiniteNumber(last.close) ? last.close : null,
          open: isFiniteNumber(last.open) ? last.open : null,
          high: isFiniteNumber(last.high) ? last.high : null,
          low: isFiniteNumber(last.low) ? last.low : null,
          previousClose: prev && isFiniteNumber(prev.close) ? prev.close : null,
          volumeToday: isFiniteNumber(last.volume) ? last.volume : null,
          marketCap: null, // needs shares outstanding — out of scope, never guessed
          asOf: last.date || null, // last daily bar's date — historical, not live
        };
      },

      /**
       * Calls the proxy's legacy /api/market-data/historical/:symbol route,
       * which already enforces the >=250-trading-day / 200-DMA minimum
       * server-side (see server/yahoo-proxy-server.js) — this function just
       * forwards `days` and returns the dailyBars array, exactly the shape
       * MarketDataService.fetchSnapshot() expects from getHistoricalDaily().
       */
      async getHistoricalDaily(symbol, days) {
        if (!isValidSymbol(symbol)) {
          throw new Error(`[BrowserDataProvider] Invalid symbol format: "${symbol}"`);
        }
        const wanted = days || 250;
        const body = await fetchJson(
          baseUrl,
          `/api/market-data/historical/${encodeURIComponent(symbol)}?days=${encodeURIComponent(wanted)}`
        );
        const bars = body.dailyBars || [];
        if (bars.length === 0) {
          throw new Error(`[BrowserDataProvider] Proxy returned no daily bars for "${symbol}".`);
        }
        return bars;
      },

      /**
       * Out of scope, same as yahoo-provider.js — the proxy has no
       * fundamentals endpoint yet. Resolves to {} rather than throwing, so
       * fetchSnapshot() still succeeds with fundamentals fields left null
       * (never fabricated). See DATA-INTEGRATION-DESIGN.md §4 for candidate
       * fundamentals sources to evaluate next (e.g. Screener.in).
       */
      async getFundamentals(_symbol) {
        return {};
      },
    };
  }

  return { create, isValidSymbol };
});
