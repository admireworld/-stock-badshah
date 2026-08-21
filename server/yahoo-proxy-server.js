/* ============================================================================
 * Stock Badshah — Screener.in Fundamentals Provider
 * ----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *   Neither yahoo-provider.js nor browser-data-provider.js supply
 *   fundamentals — both getFundamentals() implementations are documented
 *   no-op stubs that resolve to `{}` (Yahoo's Indian-fundamentals coverage
 *   is unreliable, see DATA-INTEGRATION-DESIGN.md §4). That leaves
 *   month-strategy-engine.js's Fundamental (30 pts) and Valuation (20 pts)
 *   categories — and positional-strategy-engine.js's Fundamental Quality
 *   (35 pts) and part of Valuation & Risk (15 pts) — scoring everything as
 *   0/missing forever unless something supplies pe/pb/roe/roce/growth/D-E.
 *
 *   DATA-INTEGRATION-DESIGN.md §4 already flagged Screener.in as "the best
 *   free source of exactly the fundamentals this app needs" with one
 *   explicit caveat: "No official public API; accessing it programmatically
 *   means scraping, which has its own terms-of-service and reliability
 *   considerations to evaluate before use." That caveat is not resolved by
 *   this file — it is carried forward here, unchanged, because only the
 *   person deploying this can decide whether scraping Screener.in fits
 *   their use (read their current ToS/robots.txt before turning this on).
 *
 * SCOPE — read before wiring anywhere:
 *   - FUNDAMENTALS ONLY: pe, pb, roe, roce, salesGrowthYoY,
 *     profitGrowthYoY, qoqProfitGrowth, debtToEquity, bookValue, eps,
 *     dividendYield, industryPe (from the peer-comparison table when
 *     present), fundamentalsAsOf. No price/quote/OHLCV data — that stays
 *     Yahoo's job (yahoo-provider.js / browser-data-provider.js).
 *   - This file is Node/server-side ONLY, exactly like yahoo-provider.js —
 *     it is not loaded by screener.html, index.html, or any other browser
 *     page. Screener.in does not send permissive CORS headers either, so
 *     the same "backend proxy, not direct browser call" architecture
 *     described in YAHOO-HISTORICAL-DATA-TEST-REPORT.md §4 applies here
 *     too. Wiring this into a browser-safe provider means adding a
 *     fundamentals route to a backend proxy (e.g. server/yahoo-proxy-server.js)
 *     — that file was not part of this drop, so it is not touched here;
 *     see FUNDAMENTALS-DATA-TEST-REPORT.md for the next-step note.
 *   - Does NOT modify market-data-service.js, indicator-math.js, any
 *     strategy engine, or any HTML page. It's a standalone DataProvider-
 *     shaped module (same `getFundamentals(symbol)` contract documented in
 *     market-data-service.js §3) that has to be explicitly registered
 *     (or composed with YahooProvider) before it does anything.
 *   - UNVERIFIED AGAINST THE LIVE SITE. This sandbox's network egress
 *     allowlist blocks www.screener.in (same host_not_allowed reason
 *     documented in YAHOO-HISTORICAL-DATA-TEST-REPORT.md §3a for Yahoo) —
 *     so the selectors below could not be exercised against a real
 *     response here. They're written against Screener.in's long-standing,
 *     widely-documented "top ratios" list markup
 *     (`<ul id="top-ratios"><li><span class="name">…</span><span class="number">…</span></li>`),
 *     which is the pattern used by essentially every public Screener.in
 *     scraping writeup — but that markup is exactly the kind of thing a
 *     site can change without notice, and this has NOT been confirmed
 *     against a live page. Treat every parsed field as "best-effort,
 *     needs verification on real network access" until someone runs
 *     test-screener-fundamentals.js on a machine that can reach
 *     www.screener.in and checks the output against the site by eye.
 *   - Never fabricates a field. Any ratio not found in the page (selector
 *     miss, site layout change, login-walled data, etc.) is left `null`,
 *     exactly like yahoo-provider.js drops incomplete OHLCV bars instead
 *     of guessing them.
 * ==========================================================================*/

"use strict";

const SCREENER_BASE = "https://www.screener.in/company";

// Screener.in is known to serve a lighter/blocked page to obvious bot
// traffic. Real browser UA, same rationale as yahoo-provider.js's
// REQUEST_HEADERS — not an evasion trick, just what a normal browser sends.
const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};

// Same conservative symbol validator as yahoo-provider.js. Screener.in
// URLs use the bare NSE symbol (e.g. "RELIANCE", not "RELIANCE.NS") —
// stripping a trailing ".NS"/".BO" is done in getFundamentals() below, not
// here, so this stays a pure format check.
const SYMBOL_REGEX = /^[A-Za-z0-9&-]{1,20}$/;

function isValidSymbol(symbol) {
  return typeof symbol === "string" && SYMBOL_REGEX.test(symbol.trim());
}

function toScreenerSymbol(symbol) {
  // "RELIANCE.NS" / "RELIANCE.BO" -> "RELIANCE". Screener.in itself
  // decides NSE vs BSE per-company; it is not selectable via this suffix.
  return (symbol || "").trim().replace(/\.(NS|BO)$/i, "");
}

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Screener.in renders numbers like "23.4 %", "1,23,456", "-8.2", "1,234.56
 * Cr.". Strips everything but digits/decimal/minus and parses. Returns
 * null (never 0, never a guess) if nothing numeric survives.
 */
function parseNumber(rawText) {
  if (typeof rawText !== "string") return null;
  const cleaned = rawText.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!cleaned) return null;
  const n = parseFloat(cleaned[0]);
  return isFiniteNumber(n) ? n : null;
}

/**
 * Pulls every { name, number } pair out of Screener.in's "top ratios" list.
 * ASSUMPTION (see file header): markup is
 *   <ul id="top-ratios"> ... <li ...><span class="name">X</span> ...
 *     <span class="number">Y</span> ... </li> ... </ul>
 * Deliberately tolerant of attributes/whitespace between tags, but does
 * NOT try to handle a fundamentally different markup — if Screener.in has
 * changed this, every field below comes back null rather than wrong.
 */
function extractTopRatios(html) {
  const ratios = {};

  const listMatch = html.match(/<ul[^>]*id=["']top-ratios["'][^>]*>([\s\S]*?)<\/ul>/i);
  if (!listMatch) return ratios;

  const listHtml = listMatch[1];
  const liRegex = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let li;
  while ((li = liRegex.exec(listHtml)) !== null) {
    const liHtml = li[1];
    const nameMatch = liHtml.match(/<span[^>]*class=["'][^"']*\bname\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const numberMatch = liHtml.match(/<span[^>]*class=["'][^"']*\bnumber\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    if (!nameMatch || !numberMatch) continue;

    const name = nameMatch[1].replace(/<[^>]+>/g, "").trim().toLowerCase();
    const numberText = numberMatch[1].replace(/<[^>]+>/g, "").trim();
    if (name) ratios[name] = numberText;
  }

  return ratios;
}

/**
 * Looks up a ratio by trying several label variants Screener.in is known
 * to use interchangeably (e.g. "ROE" vs "Return on equity"), returns the
 * first match's parsed number, or null if none of the variants are found.
 */
function pickRatio(ratios, labelVariants) {
  const keys = Object.keys(ratios);
  // Exact-match pass first, across ALL variants, before any substring
  // fallback — otherwise a substring match (e.g. "book value" matching
  // inside "price to book value") can steal a different field's ratio.
  // Only once no variant has an exact match do we fall back to substring
  // matching, which is looser but needed because Screener.in's exact
  // label wording drifts (e.g. "ROE" vs "Return on equity").
  for (const label of labelVariants) {
    const key = keys.find((k) => k === label);
    if (key) {
      const n = parseNumber(ratios[key]);
      if (n !== null) return n;
    }
  }
  for (const label of labelVariants) {
    const key = keys.find((k) => k.includes(label));
    if (key) {
      const n = parseNumber(ratios[key]);
      if (n !== null) return n;
    }
  }
  return null;
}

/**
 * Best-effort industry PE: Screener.in shows a peer-comparison table with
 * an "Industry PE" figure in some page variants, not all. If it's not
 * present in the "top ratios" list itself, this returns null rather than
 * scraping the (much less stable) peer table — a wrong industry PE feeds
 * directly into month/positional valuation scoring, so "null, flagged
 * missing" is safer than a shaky guess here.
 */
function extractIndustryPe(ratios) {
  return pickRatio(ratios, ["industry pe"]);
}

async function fetchCompanyHtml(screenerSymbol) {
  // "/consolidated/" first — most large-caps report consolidated
  // financials and Screener.in prefers that view when it exists; falls
  // back to the standalone page (some companies, e.g. those without
  // subsidiaries, only have the non-consolidated URL).
  const urls = [
    `${SCREENER_BASE}/${encodeURIComponent(screenerSymbol)}/consolidated/`,
    `${SCREENER_BASE}/${encodeURIComponent(screenerSymbol)}/`,
  ];

  let lastErr = null;
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: REQUEST_HEADERS });
      if (response.status === 404) {
        lastErr = new Error(`[ScreenerFundamentalsProvider] 404 at ${url}`);
        continue; // try the next URL variant
      }
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new Error(
          `[ScreenerFundamentalsProvider] Screener.in responded HTTP ${response.status} ${response.statusText} ` +
            `for "${screenerSymbol}" (${url})${bodyText ? ` — body: ${bodyText.slice(0, 300)}` : ""}`
        );
      }
      return { html: await response.text(), url };
    } catch (err) {
      lastErr = err;
    }
  }

  throw (
    lastErr ||
    new Error(`[ScreenerFundamentalsProvider] No reachable Screener.in page found for "${screenerSymbol}".`)
  );
}

const ScreenerFundamentalsProvider = {
  id: "screener-in-fundamentals",

  isValidSymbol,
  toScreenerSymbol, // exported for tests / callers that want the mapped symbol

  /**
   * Out of scope for this provider — it supplies fundamentals only, never
   * a quote. Throws (rather than returning nulls) so a caller mistakenly
   * treating this as a full DataProvider fails loudly instead of silently
   * producing an all-null quote block.
   */
  async getQuote(symbol) {
    throw new Error(
      `[ScreenerFundamentalsProvider] This provider supplies fundamentals only — no getQuote() for "${symbol}". ` +
        "Use yahoo-provider.js / browser-data-provider.js for quotes and historical bars."
    );
  },

  /** Same reasoning as getQuote() above. */
  async getHistoricalDaily(symbol) {
    throw new Error(
      `[ScreenerFundamentalsProvider] This provider supplies fundamentals only — no getHistoricalDaily() for "${symbol}".`
    );
  },

  /**
   * Fetches and parses Screener.in's public company page for `symbol`
   * (accepts "RELIANCE" or "RELIANCE.NS"/"RELIANCE.BO" — the exchange
   * suffix is stripped). Returns a Partial<StockDataSnapshot> matching
   * exactly the fundamentals fields market-data-service.js's
   * StockDataSnapshot documents. Any ratio the parser can't confidently
   * find is left `null` — never guessed, never defaulted to 0.
   */
  async getFundamentals(symbol) {
    if (!isValidSymbol(toScreenerSymbol(symbol))) {
      throw new Error(`[ScreenerFundamentalsProvider] Invalid symbol format: "${symbol}"`);
    }

    const screenerSymbol = toScreenerSymbol(symbol);
    const { html, url } = await fetchCompanyHtml(screenerSymbol);
    const ratios = extractTopRatios(html);

    if (Object.keys(ratios).length === 0) {
      throw new Error(
        `[ScreenerFundamentalsProvider] Fetched ${url} but found no parseable "top ratios" data — ` +
          "either Screener.in changed its page markup (see ASSUMPTION note at the top of this file) " +
          `or "${screenerSymbol}" has no fundamentals page. Not fabricating a fundamentals object.`
      );
    }

    return {
      pe: pickRatio(ratios, ["stock p/e", "price to earning", "p/e"]),
      pb: pickRatio(ratios, ["price to book", "p/b"]),
      industryPe: extractIndustryPe(ratios),
      roe: pickRatio(ratios, ["roe", "return on equity"]),
      roce: pickRatio(ratios, ["roce", "return on capital employed"]),
      salesGrowthYoY: pickRatio(ratios, ["sales growth"]),
      profitGrowthYoY: pickRatio(ratios, ["profit growth", "profit var"]),
      // Screener.in's "top ratios" list does not carry a QoQ figure —
      // that lives in the quarterly-results table, which this provider
      // does not parse (table layout is far less stable than the ratios
      // list; see file header). Left null and flagged here rather than
      // scraped shakily — month/positional engines already treat a
      // missing qoqProfitGrowth as "scorer awards 0, note attached", not
      // a crash.
      qoqProfitGrowth: null,
      debtToEquity: pickRatio(ratios, ["debt to equity", "debt/eq"]),
      bookValue: pickRatio(ratios, ["book value"]),
      eps: pickRatio(ratios, ["eps"]),
      dividendYield: pickRatio(ratios, ["dividend yield"]),
      fundamentalsAsOf: new Date().toISOString(), // page-fetch time; Screener.in itself doesn't stamp a per-ratio "as of" in this list
      source: "screener-in-fundamentals",
      sourceUrl: url,
    };
  },
};

/**
 * Composes a full DataProvider (matching market-data-service.js §3's
 * interface: getQuote + getHistoricalDaily + getFundamentals) out of two
 * single-purpose providers — e.g. YahooProvider for quote/historical and
 * ScreenerFundamentalsProvider for fundamentals. Neither source provider
 * needs to change; this is pure composition, same "swap the vendor, not
 * the interface" philosophy as everything else in this project.
 *
 * Does NOT register itself anywhere and does NOT change
 * market-data-service.js — a caller still does
 * `MarketDataService.registerProvider(createCombinedProvider({...}))`
 * explicitly, exactly like YahooProvider is registered today in
 * test-yahoo-historical-data.js.
 *
 * If fundamentalsProvider.getFundamentals() throws (e.g. Screener.in
 * blocked/down/layout changed), that error propagates as-is — it is NOT
 * swallowed into an empty `{}` here, unlike yahoo-provider.js's own
 * intentional no-op stub. Rationale: when fundamentals are the whole
 * point of registering this combined provider, a silent `{}` would look
 * identical to "this company has no fundamentals," which is misleading.
 * Callers who'd rather degrade gracefully can catch it themselves around
 * fetchSnapshot() / getFundamentals().
 */
function createCombinedProvider(options) {
  const opts = options || {};
  const technicalProvider = opts.technicalProvider;
  const fundamentalsProvider = opts.fundamentalsProvider || ScreenerFundamentalsProvider;

  if (!technicalProvider || typeof technicalProvider.getQuote !== "function") {
    throw new Error(
      "[ScreenerFundamentalsProvider] createCombinedProvider() needs a { technicalProvider } implementing " +
        "getQuote()/getHistoricalDaily() — e.g. YahooProvider or BrowserDataProvider.create({...})."
    );
  }

  return {
    id: `${technicalProvider.id}+${fundamentalsProvider.id}`,
    async getQuote(symbol) {
      return technicalProvider.getQuote(symbol);
    },
    async getHistoricalDaily(symbol, days) {
      return technicalProvider.getHistoricalDaily(symbol, days);
    },
    async getFundamentals(symbol) {
      return fundamentalsProvider.getFundamentals(symbol);
    },
  };
}

if (typeof module === "object" && module.exports) {
  module.exports = ScreenerFundamentalsProvider;
  module.exports.createCombinedProvider = createCombinedProvider;
}
