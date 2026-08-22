/**
 * Cross-provider price consistency.
 *
 * This exists because of the sharpest criticism of the whole design, which is
 * correct: staleness is measured against a timestamp the provider itself signs
 * and controls. A provider that serves 45-minute-old data but stamps it `now()`
 * passes all six checks, and no cryptographic test can catch it. Its signature
 * is valid, its hash matches, its timestamp is inside the bound. It simply
 * lied, and a lie about time is indistinguishable from the truth in isolation.
 *
 * It is not indistinguishable across a market.
 *
 * Every provider publishes (claimed_timestamp, price) pairs. A provider that is
 * honest about being stale — reporting old prices with old timestamps — sits on
 * the same price path as one reporting fresh prices with fresh timestamps: both
 * are telling the truth about a different moment. A forger does not. Its points
 * claim "now" while carrying a value from 45 minutes ago, so it disagrees with
 * everyone else about what the price was at that claimed moment.
 *
 * Two properties worth being explicit about:
 *
 *   - No oracle. The reference is reconstructed from what providers collectively
 *     claim, not from a source we designate as truthful. A minority forger
 *     stands out against the others; we never assert what the price "really" is.
 *   - This is evidence, never proof. Nothing here is slashable and nothing here
 *     touches the contract. It feeds the observed score, so a forger loses
 *     traffic rather than collateral. Slashing on a statistic would be exactly
 *     the centralised adjudication this project exists to avoid.
 */
import type { SampleRow } from "./db.ts";

/** How close in claimed time two observations must be to be comparable. */
const MATCH_WINDOW_S = 90;
/** Relative disagreement above which a sample is judged inconsistent. */
const TOLERANCE = 0.004; // 0.4%
/**
 * Distinct providers that must cover a claimed moment before we will judge it.
 *
 * Three, and the subject is one of them. Two is not enough for two reasons:
 * the median of two values is their midpoint, so an honest provider and a
 * forger each come out looking half-wrong; and with only one other opinion a
 * disagreement is a tie, where picking a side is guessing rather than
 * measuring. Three is the smallest set where a majority can exist.
 */
const MIN_PROVIDERS = 3;

export type ConsistencyStat = {
  /** Samples we had enough peer coverage to judge. */
  checked: number;
  /** Of those, how many agreed with the rest of the market. */
  consistent: number;
  /** Median relative disagreement, as a fraction (0.012 = 1.2%). */
  medianDivergence: number;
  /** True once there is enough evidence to act on. */
  conclusive: boolean;
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * For each sample, compare its signed price against what every *other* provider
 * said the price was at the same claimed moment.
 */
export function computeConsistency(rows: SampleRow[]): Map<string, ConsistencyStat> {
  const usable = rows.filter(
    r => typeof r.price === "number" && r.price > 0 && typeof r.claimed_ts === "number" && r.claimed_ts > 0,
  );

  const perProvider = new Map<string, { divergences: number[]; consistent: number }>();

  for (const row of usable) {
    // Everyone covering this claimed moment, the subject included. Including it
    // is deliberate: a median over a set with an honest majority lands on the
    // honest value regardless, and excluding the subject manufactures a tie
    // whenever exactly two providers cover a moment.
    const cohort = usable.filter(
      other => Math.abs(other.claimed_ts - row.claimed_ts) <= MATCH_WINDOW_S,
    );
    const voters = new Set(cohort.map(p => p.provider));
    if (voters.size < MIN_PROVIDERS) continue;

    // One vote per provider, so a chatty provider cannot outweigh the rest by
    // contributing more points.
    const perVoter = [...voters].map(id =>
      median(cohort.filter(p => p.provider === id).map(p => p.price)),
    );
    const reference = median(perVoter);
    if (reference <= 0) continue;

    const divergence = Math.abs(row.price - reference) / reference;
    const entry = perProvider.get(row.provider) ?? { divergences: [], consistent: 0 };
    entry.divergences.push(divergence);
    if (divergence <= TOLERANCE) entry.consistent++;
    perProvider.set(row.provider, entry);
  }

  const out = new Map<string, ConsistencyStat>();
  for (const [provider, e] of perProvider) {
    out.set(provider, {
      checked: e.divergences.length,
      consistent: e.consistent,
      medianDivergence: Math.round(median(e.divergences) * 100_000) / 100_000,
      // A handful of points is not a verdict about anyone's honesty.
      conclusive: e.divergences.length >= 5,
    });
  }
  return out;
}

export const CONSISTENCY_TOLERANCE = TOLERANCE;
