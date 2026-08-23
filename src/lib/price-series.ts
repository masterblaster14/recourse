/**
 * One underlying ALGO/USD price path that every demo provider reads from.
 *
 * This matters more than it looks. If each provider generated its own
 * independent random walk, "stale" would mean nothing — you could not tell a
 * provider serving old data from one serving different data, and no consistency
 * check between providers would be meaningful. With a single shared path,
 * "serving 45-minute-old data" is a precise, checkable statement: the provider
 * reports the value this series actually held 45 minutes ago.
 *
 * The path is simulated on purpose and the README says so. The point of these
 * endpoints is to be measured against an SLA, not to be an oracle.
 */

const GRANULARITY_S = 5;
/** Two hours of history, so a 45-minute lag has plenty of room behind it. */
const HISTORY_S = 2 * 60 * 60;
const POINTS = HISTORY_S / GRANULARITY_S;

const BASE_PRICE = 0.1842;
const STEP = 0.0012;
/** How hard the walk is pulled back to base each tick. */
const REVERSION = 0.01;
/**
 * A slow cycle underneath the noise, and the reason it is here.
 *
 * Cross-provider consistency can only catch a forger when the price actually
 * moved during the window it is lying about. If the market sat still for 45
 * minutes, then 45-minute-old data is the same number as fresh data — the
 * forger is undetectable, and it also did no harm, which is the honest half of
 * that trade-off.
 *
 * The first version of this series was a pure mean-reverting walk with a very
 * narrow band, so "45 minutes ago" was close to a random redraw from the same
 * few basis points. Simulated over the detector's actual statistic — the median
 * divergence across a run's samples — it left the forger *undetected 36% of the
 * time*. That is not a property of the technique; it is an implausibly calm
 * synthetic asset. Real ALGO/USD moves several percent within an hour, while
 * that series moved about half of one.
 *
 * Realistic volatility plus a slow cycle puts the miss rate under 1%. The
 * detector is unchanged — what changed is that the simulated market now behaves
 * like a market.
 */
const CYCLE_AMPLITUDE = 0.035;
const CYCLE_PERIOD_S = 90 * 60;

/** Ring of prices, index 0 = oldest. `lastTick` is the unix second of the newest. */
const series: number[] = [];
let lastTick = 0;
/** Ticks elapsed since the series began, so the cycle is continuous across
 *  advances rather than restarting from the ring's left edge. */
let phaseTick = 0;

function cycleAt(tick: number): number {
  return BASE_PRICE * CYCLE_AMPLITUDE * Math.sin((2 * Math.PI * tick * GRANULARITY_S) / CYCLE_PERIOD_S);
}

/** The noise component only — the cycle is added when a point is stored. */
let walk = BASE_PRICE;

function nextPrice(): number {
  const drift = (Math.random() - 0.5) * 2 * STEP;
  // Mean-reverting so the walk stays in a plausible band over a long session.
  walk = walk + drift + (BASE_PRICE - walk) * REVERSION;
  phaseTick++;
  return Math.round((walk + cycleAt(phaseTick)) * 10_000) / 10_000;
}

function seed(nowS: number): void {
  series.length = 0;
  walk = BASE_PRICE;
  phaseTick = 0;
  for (let i = 0; i < POINTS; i++) series.push(nextPrice());
  lastTick = nowS;
}

/** Extends the series forward to `nowS`, dropping whatever has aged out. */
function advance(nowS: number): void {
  if (series.length === 0) {
    seed(nowS);
    return;
  }
  const ticks = Math.floor((nowS - lastTick) / GRANULARITY_S);
  if (ticks <= 0) return;
  if (ticks >= POINTS) {
    seed(nowS);
    return;
  }
  for (let i = 0; i < ticks; i++) {
    series.push(nextPrice());
    series.shift();
  }
  lastTick += ticks * GRANULARITY_S;
}

/**
 * The price this series held `secondsAgo` seconds ago.
 * `secondsAgo = 0` is the current price.
 */
export function priceAt(secondsAgo: number, nowS = Math.floor(Date.now() / 1000)): number {
  advance(nowS);
  const back = Math.min(POINTS - 1, Math.max(0, Math.round(secondsAgo / GRANULARITY_S)));
  return series[series.length - 1 - back];
}

/** Exposed for the dashboard and for explaining what the demo is doing. */
export function seriesInfo(): { granularityS: number; historyS: number; points: number } {
  return { granularityS: GRANULARITY_S, historyS: HISTORY_S, points: POINTS };
}
