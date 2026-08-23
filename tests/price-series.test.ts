/**
 * The forger is only catchable when the price moved during the window it lied
 * about.
 *
 * That is a real property of cross-provider consistency, not a flaw: if the
 * market sat still for 45 minutes then 45-minute-old data is the same number as
 * fresh data — undetectable, and also harmless.
 *
 * But it makes the *simulated* asset's volatility load-bearing. The first
 * version of this series was a mean-reverting walk in a very narrow band, so
 * "45 minutes ago" was close to a random redraw from the same few basis points.
 * Measured against the detector's actual statistic — the median divergence
 * across a run's samples — it left the forger undetected 36% of the time. Two
 * consecutive production runs produced 1.13% and 0.27% divergence, one caught
 * and one not, which is how it was found.
 *
 * These tests hold the series to something a market could plausibly do, so the
 * demo does not turn on a coin flip.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { priceAt, seriesInfo } from "../src/lib/price-series.ts";
import { CONSISTENCY_TOLERANCE } from "../src/lib/consistency.ts";

/** What the stale provider back-dates by, from `STALE_OFFSET_S`. */
const STALE_LAG_S = 2700;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

describe("price series", () => {
  test("keeps enough history to look 45 minutes back", () => {
    const info = seriesInfo();
    assert.ok(info.historyS > STALE_LAG_S * 1.5, "history must comfortably exceed the stale lag");
    assert.ok(info.points > STALE_LAG_S / info.granularityS);
  });

  test("prices stay in a plausible band", () => {
    const now = 1_800_000_000;
    for (let ago = 0; ago < 7200; ago += 60) {
      const p = priceAt(ago, now);
      assert.ok(p > 0.05 && p < 0.5, `implausible price ${p}`);
    }
  });

  test("a 45-minute-old price is usually well clear of the current one", () => {
    // The detector takes a median across a run's samples, so that is what is
    // measured here rather than a single pair.
    let missed = 0;
    const TRIALS = 40;
    for (let t = 0; t < TRIALS; t++) {
      // Fresh seed each trial: a jump beyond the ring reseeds the series.
      const now = 1_800_000_000 + t * 60 * 60 * 24;
      const divergences: number[] = [];
      for (let k = 0; k < 6; k++) {
        const at = now + k * 22; // roughly the sampling gap in a 26-call run
        const fresh = priceAt(0, at);
        const stale = priceAt(STALE_LAG_S, at);
        divergences.push(Math.abs(fresh - stale) / fresh);
      }
      if (median(divergences) <= CONSISTENCY_TOLERANCE) missed++;
    }
    // The old series missed roughly a third of the time. Allow a wide margin
    // here — this guards against a return to a becalmed asset, not against
    // ordinary randomness.
    assert.ok(
      missed <= TRIALS * 0.25,
      `forger would go undetected in ${missed}/${TRIALS} runs — the simulated ` +
        `asset is too calm for the demo to be reliable`,
    );
  });

  test("the current price is the newest point, not an average", () => {
    const now = 1_800_000_000;
    assert.equal(priceAt(0, now), priceAt(0, now), "must be stable within a tick");
    assert.notEqual(priceAt(0, now), priceAt(STALE_LAG_S, now));
  });
});
