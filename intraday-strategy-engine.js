/**
 * ============================================================================
 * IntradayStrategyEngine — Gap & Retracement (Previous-Day-Levels) strategy
 * ============================================================================
 * STATUS: Design/logic only, same convention as week-strategy-engine.js /
 * month-strategy-engine.js / positional-strategy-engine.js in this project.
 * This file does NOT fabricate, sample, or hardcode any market data. It is a
 * pure function of whatever candles/levels are handed to it. If the input is
 * incomplete, it returns signal: 'NO TRADE' with a warning — it never guesses.
 *
 * RULE FLOW (matches the approved flowchart 1:1):
 *   1. Mark previous day levels: PDH, PDL, PDO, PDC.
 *   2. Compare today's open to PDC -> GAP-UP or GAP-DOWN (flat = no trade).
 *      GAP-UP  -> BUY side only.
 *      GAP-DOWN -> SELL side only.
 *   3. Wait for price to trade into the Previous-Day Open/Close zone
 *      (the band between PDO and PDC).
 *   4. Inside that zone, wait for a confirmation 5-min candle:
 *        BUY side  -> green candle (close > open), closing in the upper 30%
 *                     of its own high-low range.
 *        SELL side -> red candle (close < open), closing in the lower 30%
 *                     of its own high-low range.
 *   5. On the candle(s) after confirmation, wait for a >=50% retracement of
 *      the confirmation candle's range. That retracement price is the entry.
 *   6. Stop loss:
 *        - "Normal" wick on the confirmation candle -> use that candle's
 *          low (BUY) / high (SELL).
 *        - "Big" wick (>=40% of the candle's range) -> distrust that wick;
 *          use the nearest PDO/PDC/PDH/PDL beyond the entry instead.
 *   7. Risk = |entry - stopLoss|. Reject the trade unless there is real
 *      room to a minimum 1:2 reward — i.e. the nearest opposing previous-day
 *      level (which could act as a ceiling/floor) must be at least 2x risk
 *      away. If not, NO TRADE ("Target blocked by a nearby PD level").
 *      Otherwise: target = entry +/- 2x risk.
 *
 * INPUT CONTRACT — IntradayStrategyEngine.analyzeStock(input)
 *   input = {
 *     symbol: 'RELIANCE.NS',
 *     prevDay: { open, high, low, close },   // PDO, PDH, PDL, PDC
 *     todayOpen: number,
 *     bars5m: [                              // today's 5-min candles, market
 *       { time, open, high, low, close, volume }, // open onward, ascending
 *       ...
 *     ]
 *   }
 *
 * OUTPUT CONTRACT (kept parallel to the other engines' return shape so the
 * existing table-rendering code in *-strategy.html can be reused as-is):
 *   {
 *     symbol, gapType, side, signal,          // signal: 'BUY' | 'SELL' | 'NO TRADE'
 *     stage,                                   // human-readable reason / step reached
 *     entryPrice, stopLoss, target1, riskReward,
 *     holdingPeriod: 'Intraday (same session)',
 *     warnings: []
 *   }
 * ============================================================================
 */
(function (window) {
  'use strict';

  var RETRACEMENT_RATIO = 0.5;      // 50% retracement trigger
  var CONFIRMATION_CLOSE_ZONE = 0.30; // close must be in outer 30% of candle range
  var BIG_WICK_RATIO = 0.40;        // wick >= 40% of range counts as a "big" wick
  var MIN_RR = 2;                   // minimum 1:2 risk:reward
  var RETRACEMENT_LOOKAHEAD = 3;    // how many candles after confirmation we wait for retracement

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  function candleRange(c) {
    return c.high - c.low;
  }

  function isGreen(c) { return c.close > c.open; }
  function isRed(c) { return c.close < c.open; }

  // Fraction of the candle's range where the close sits (0 = at low, 1 = at high)
  function closePosition(c) {
    var range = candleRange(c);
    if (range <= 0) return 0.5;
    return (c.close - c.low) / range;
  }

  function inZone(c, zoneLow, zoneHigh) {
    return c.high >= zoneLow && c.low <= zoneHigh;
  }

  function isConfirmationCandle(c, side) {
    var range = candleRange(c);
    if (range <= 0) return false;
    if (side === 'BUY') {
      return isGreen(c) && closePosition(c) >= (1 - CONFIRMATION_CLOSE_ZONE);
    }
    return isRed(c) && closePosition(c) <= CONFIRMATION_CLOSE_ZONE;
  }

  // Nearest previous-day level beyond `price` in the direction away from entry
  // (used as fallback stop when the confirmation candle's wick is untrustworthy).
  function nearestLevelBeyond(price, side, prevDay) {
    var levels = [prevDay.open, prevDay.high, prevDay.low, prevDay.close];
    var candidates;
    if (side === 'BUY') {
      candidates = levels.filter(function (l) { return l < price; });
      if (!candidates.length) return null;
      return Math.max.apply(null, candidates); // closest below
    }
    candidates = levels.filter(function (l) { return l > price; });
    if (!candidates.length) return null;
    return Math.min.apply(null, candidates); // closest above
  }

  // The level that could realistically cap the move on the reward side.
  // The zone we just traded FROM (PDO/PDC) isn't an obstacle — we're already
  // through it. The next real ceiling/floor is the previous day's High (for a
  // BUY) or Low (for a SELL).
  function nearestOpposingLevel(entry, side, prevDay) {
    if (side === 'BUY') {
      return prevDay.high > entry ? prevDay.high : null;
    }
    return prevDay.low < entry ? prevDay.low : null;
  }

  function noTrade(base, stage, warnings) {
    return Object.assign({}, base, {
      signal: 'NO TRADE',
      stage: stage,
      entryPrice: null,
      stopLoss: null,
      target1: null,
      riskReward: null,
      holdingPeriod: 'Intraday (same session)',
      warnings: warnings || []
    });
  }

  function analyzeStock(input) {
    var warnings = [];
    if (!input || !input.symbol) {
      return noTrade({ symbol: input && input.symbol || '—', gapType: null, side: null }, 'Missing input', ['No input supplied.']);
    }

    var symbol = input.symbol;
    var prevDay = input.prevDay;
    var todayOpen = input.todayOpen;
    var bars = input.bars5m || [];

    var base = { symbol: symbol, gapType: null, side: null };

    if (!prevDay || typeof prevDay.open !== 'number' || typeof prevDay.high !== 'number' ||
        typeof prevDay.low !== 'number' || typeof prevDay.close !== 'number') {
      return noTrade(base, 'Waiting for previous-day OHLC (PDH/PDL/PDO/PDC)', ['prevDay levels not available.']);
    }
    if (typeof todayOpen !== 'number') {
      return noTrade(base, "Waiting for today's opening price", ["today's open not available."]);
    }

    // ---- Step 2: gap direction -----------------------------------------
    var gapType, side;
    if (todayOpen > prevDay.close) {
      gapType = 'GAP_UP'; side = 'BUY';
    } else if (todayOpen < prevDay.close) {
      gapType = 'GAP_DOWN'; side = 'SELL';
    } else {
      gapType = 'FLAT'; side = null;
    }
    base.gapType = gapType;
    base.side = side;

    if (!side) {
      return noTrade(base, 'Flat open — no gap, no setup today', []);
    }

    if (!bars.length) {
      return noTrade(base, 'Waiting for intraday 5-min candles', ["bars5m not available yet."]);
    }

    var zoneLow = Math.min(prevDay.open, prevDay.close);
    var zoneHigh = Math.max(prevDay.open, prevDay.close);

    // ---- Step 3: has price traded into the PD open/close zone? ---------
    var zoneIdx = -1;
    for (var i = 0; i < bars.length; i++) {
      if (inZone(bars[i], zoneLow, zoneHigh)) { zoneIdx = i; break; }
    }
    if (zoneIdx === -1) {
      return noTrade(base, 'Price has not reached the previous-day Open/Close zone yet', []);
    }

    // ---- Step 4: confirmation candle at/after the zone touch -----------
    var confirmIdx = -1;
    for (var j = zoneIdx; j < bars.length; j++) {
      if (isConfirmationCandle(bars[j], side)) { confirmIdx = j; break; }
    }
    if (confirmIdx === -1) {
      return noTrade(base, side === 'BUY'
        ? 'In zone, waiting for a green confirmation candle closing in its upper 30%'
        : 'In zone, waiting for a red confirmation candle closing in its lower 30%', []);
    }

    var confirmCandle = bars[confirmIdx];
    var confirmRange = candleRange(confirmCandle);

    // ---- Step 5: 50% retracement of the confirmation candle -------------
    var retracementLevel = side === 'BUY'
      ? confirmCandle.high - RETRACEMENT_RATIO * confirmRange
      : confirmCandle.low + RETRACEMENT_RATIO * confirmRange;

    var triggerIdx = -1;
    var lookaheadEnd = Math.min(bars.length - 1, confirmIdx + RETRACEMENT_LOOKAHEAD);
    for (var k = confirmIdx + 1; k <= lookaheadEnd; k++) {
      var c = bars[k];
      if (side === 'BUY' ? c.low <= retracementLevel : c.high >= retracementLevel) {
        triggerIdx = k; break;
      }
    }
    if (triggerIdx === -1) {
      return noTrade(base, 'Confirmation candle formed, waiting for 50% retracement', []);
    }

    var entryPrice = round2(retracementLevel);

    // ---- Step 6: stop loss, trusting or distrusting the wick ------------
    var body = Math.abs(confirmCandle.close - confirmCandle.open);
    var lowerWick = Math.min(confirmCandle.open, confirmCandle.close) - confirmCandle.low;
    var upperWick = confirmCandle.high - Math.max(confirmCandle.open, confirmCandle.close);
    var relevantWick = side === 'BUY' ? lowerWick : upperWick;
    var bigWick = confirmRange > 0 && (relevantWick / confirmRange) >= BIG_WICK_RATIO;

    var stopLoss;
    if (bigWick) {
      var fallback = nearestLevelBeyond(entryPrice, side, prevDay);
      if (fallback === null) {
        warnings.push('Wick on the confirmation candle was too large to trust, and no PD level was available as a fallback stop.');
        stopLoss = side === 'BUY' ? confirmCandle.low : confirmCandle.high;
      } else {
        stopLoss = round2(fallback);
        warnings.push('Confirmation candle had a large wick — stop loss set at the nearest previous-day level instead of the candle wick.');
      }
    } else {
      stopLoss = round2(side === 'BUY' ? confirmCandle.low : confirmCandle.high);
    }

    var risk = side === 'BUY' ? entryPrice - stopLoss : stopLoss - entryPrice;
    if (!(risk > 0)) {
      return noTrade(base, 'Computed risk was zero or negative — invalid candle data', ['risk <= 0, skipping trade.']);
    }

    // ---- Step 7: is there real room for a minimum 1:2 R:R? --------------
    var opposingLevel = nearestOpposingLevel(entryPrice, side, prevDay);
    var roomAvailable = opposingLevel === null
      ? true // no PD level in the way — nothing observed blocking the target
      : (side === 'BUY' ? (opposingLevel - entryPrice) : (entryPrice - opposingLevel)) >= MIN_RR * risk;

    if (!roomAvailable) {
      return noTrade(Object.assign({}, base, { entryPrice: entryPrice, stopLoss: stopLoss }),
        'Retracement hit, but target space to the nearest PD level is below minimum 1:2 R:R', []);
    }

    var target1 = round2(side === 'BUY' ? entryPrice + MIN_RR * risk : entryPrice - MIN_RR * risk);

    return {
      symbol: symbol,
      gapType: gapType,
      side: side,
      signal: side, // 'BUY' or 'SELL'
      stage: side === 'BUY' ? 'BUY triggered — retracement filled, 1:2 R:R confirmed' : 'SELL triggered — retracement filled, 1:2 R:R confirmed',
      entryPrice: entryPrice,
      stopLoss: stopLoss,
      target1: target1,
      riskReward: round2(MIN_RR),
      holdingPeriod: 'Intraday (same session)',
      warnings: warnings
    };
  }

  window.IntradayStrategyEngine = {
    analyzeStock: analyzeStock,
    // exposed for testing / debugging in the console
    _internals: {
      isConfirmationCandle: isConfirmationCandle,
      nearestLevelBeyond: nearestLevelBeyond,
      nearestOpposingLevel: nearestOpposingLevel
    }
  };
})(window);
