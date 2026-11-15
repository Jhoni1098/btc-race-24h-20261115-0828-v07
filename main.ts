// BTC race bot — breakout momentum, long-only, one position at a time.
//
// Idea: in a noisy 1-minute market a full round trip costs ~40 bps (4 bps fee
// + 2 bps slippage + ~15 bps of constant-product impact each way at full
// size), so the bot only trades when a LARGE move is already underway. It
// buys when the trailing W-bar return clears a high threshold (a bounce or
// a fresh up-leg, confirmed, not a guess at the bottom) and exits on a tight
// trailing stop, a hard stop, or a momentum reversal. It stays in cash
// through the chop, which is how it survives a falling window: cash earns
// nothing, but it also loses nothing.
//
// All tunable values are constants at the top, in basis points unless noted,
// so a variant is a one-line change. Deterministic: integer (BigInt) math
// only, no clock, no environment, no Math.random.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

// ---------------------------------------------------------------- parameters
/** Lookback window, in bars, for the momentum return. */
const W_BARS = 20;
/** Enter when the W-bar return is at least this (bps): +1.20%. */
const UP_BPS = 150;
/** Exit when the W-bar return falls to this (bps): -0.80%. */
const DOWN_BPS = -80;
/** Trailing stop (bps): sell when the close falls this far below the peak
 *  close since entry: 0.80%. */
const TRAIL_BPS = 80;
/** Hard stop (bps): sell when the close falls this far below the entry
 *  close: 2.00%. */
const STOP_BPS = 200;
/** Take-profit (bps): 0 disables it; otherwise sell when the close rises
 *  this far above the entry close. */
const TAKE_PROFIT_BPS = 0;
/** Fraction of cash deployed per entry (bps of cash): 10000 = all-in. */
const SIZE_BPS = 5000;
/** Slippage cap on every order (bps): wide open, so a gap never rejects. */
const MAX_SLIPPAGE_BPS = 10000;

const SYMBOL = 'CBBTC';
const BPS = 10000n;

// ---------------------------------------------------------------- state
/** Every close seen so far, raw (price_scale 5), oldest first. */
const closes: bigint[] = [];
/** Close of the bar on which the current position was opened (0 when flat). */
let entryClose = 0n;
/** Highest close since the current position was opened (0 when flat). */
let peakClose = 0n;

/** True when the W-bar return clears `thresholdBps` (signed). */
function returnClears(thresholdBps: number): boolean {
  if (closes.length <= W_BARS) return false;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - W_BARS];
  const threshold = BPS + BigInt(thresholdBps);
  // now / then >= threshold / 10000  <=>  now * 10000 >= then * threshold
  return now * BPS >= then * threshold;
}

/** True when the latest close has fallen `bps` below `reference`. */
function fellBelow(reference: bigint, bps: number): boolean {
  if (reference === 0n || closes.length === 0) return false;
  const now = closes[closes.length - 1];
  return now * BPS < reference * (BPS - BigInt(bps));
}

/** True when the latest close has risen `bps` above `reference`. */
function roseAbove(reference: bigint, bps: number): boolean {
  if (reference === 0n || closes.length === 0) return false;
  const now = closes[closes.length - 1];
  return now * BPS > reference * (BPS + BigInt(bps));
}

await runBars({
  onBatch(state: BarsState): OrderInput[] {
    const close = state.close(SYMBOL);
    if (close === null) return [];
    closes.push(close);

    const holding = state.positions.has(SYMBOL);
    if (!holding) {
      if (returnClears(UP_BPS)) {
        const notional = (state.cash * BigInt(SIZE_BPS)) / BPS;
        if (notional < 1_000_000n) return [];
        entryClose = close;
        peakClose = close;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Holding: update the peak, then check exits.
    if (close > peakClose) peakClose = close;
    const qty = state.positions.get(SYMBOL)!.qty;
    if (downReturn() || fellBelow(entryClose, STOP_BPS) || fellBelow(peakClose, TRAIL_BPS) || (TAKE_PROFIT_BPS > 0 && roseAbove(entryClose, TAKE_PROFIT_BPS))) {
      entryClose = 0n;
      peakClose = 0n;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});

/** True when the W-bar return is at or below DOWN_BPS. */
function downReturn(): boolean {
  if (closes.length <= W_BARS) return false;
  const now = closes[closes.length - 1];
  const then = closes[closes.length - 1 - W_BARS];
  return now * BPS <= then * (BPS + BigInt(DOWN_BPS));
}
