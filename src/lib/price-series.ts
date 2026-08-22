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
const STEP = 0.00035;

/** Ring of prices, index 0 = oldest. `lastTick` is the unix second of the newest. */
const series: number[] = [];
let lastTick = 0;

function nextPrice(previous: number): number {
  const drift = (Math.random() - 0.5) * 2 * STEP;
  // Mean-reverting so the walk stays in a plausible band over a long session.
  const pull = (BASE_PRICE - previous) * 0.02;
  return Math.round((previous + drift + pull) * 10_000) / 10_000;
}

function seed(nowS: number): void {
  series.length = 0;
  let p = BASE_PRICE;
  for (let i = 0; i < POINTS; i++) {
    p = nextPrice(p);
    series.push(p);
  }
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
    series.push(nextPrice(series[series.length - 1]));
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
