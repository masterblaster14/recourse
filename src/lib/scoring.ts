/**
 * Reliability scoring.
 *
 * The important design decision here is `confidence`. A provider with one
 * successful call is not 100% reliable, it is unmeasured, and the score has to
 * say so out loud. Without that, every brand-new provider looks perfect and the
 * score is worse than useless — it actively misleads the agent buying from it.
 */
import { env, fromMicro } from "../env.ts";
import type { SampleAggregate } from "./db.ts";
import type { ProviderState } from "./chain.ts";

export type Confidence = "low" | "medium" | "high";
/**
 * `unrated` is not a hedge, it is the accurate answer when the evidence is too
 * thin to say anything. Collapsing it into `avoid` would tell an agent that a
 * brand-new honest provider is as bad as one caught cheating, which is exactly
 * the incumbent-protecting behaviour Recourse exists to remove.
 */
export type Recommendation = "buy" | "caution" | "avoid" | "unrated";

export type ScoreBreakdown = {
  schema: number;
  staleness: number;
  latency: number;
  claimPenalty: number;
};

export type Score = {
  reliability: number;
  /** 95% Wilson lower bound on the all-checks-passed rate. Act on this. */
  reliabilityLower: number;
  reliabilityUpper: number;
  confidence: Confidence;
  recommendation: Recommendation;
  breakdown: ScoreBreakdown;
};

/**
 * Wilson score interval for a binomial proportion.
 *
 * This is the honest answer to "a provider with one successful call is not 100%
 * reliable, it is unmeasured". A raw pass rate cannot express that: 1/1 and
 * 500/500 both read as 1.0. Wilson gives an interval that is wide when there is
 * little evidence and tight when there is a lot, so `confidence` becomes a
 * statement about how much we know rather than an arbitrary sample-count
 * bucket, and the recommendation can act on the lower bound instead of the
 * point estimate.
 *
 *   16/16 -> [0.806, 1.000]   plausible, but not yet buyable
 *   50/50 -> [0.929, 1.000]
 *  200/200 -> [0.981, 1.000]
 */
export function wilsonInterval(
  successes: number,
  total: number,
  z = 1.96,
): { lower: number; upper: number } {
  if (total <= 0) return { lower: 0, upper: 1 };
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return {
    lower: Math.max(0, (centre - spread) / denom),
    upper: Math.min(1, (centre + spread) / denom),
  };
}

const WEIGHTS = { schema: 0.5, staleness: 0.3, latency: 0.2 } as const;

/**
 * Confidence is how narrow the interval is, floored by a raw sample count so a
 * lucky run of identical results cannot masquerade as certainty.
 */
export function confidenceFor(samples: number, width: number): Confidence {
  if (samples >= 50 && width <= 0.1) return "high";
  if (samples >= 15 && width <= 0.3) return "medium";
  return "low";
}

/**
 * Acts on the lower bound, not the point estimate. An agent about to spend
 * unattended money should be told the worst case the evidence supports.
 *
 * A proven violation short-circuits the "not enough evidence" branch: one
 * upheld claim is a fact, not a sample, and it counts immediately.
 */
export function recommendationFor(
  lowerBound: number,
  confidence: Confidence,
  opts: { samples: number; upheldClaims: number },
): Recommendation {
  if (opts.upheldClaims === 0) {
    if (opts.samples === 0) return "unrated";
    if (confidence === "low") return "unrated";
  }
  if (lowerBound > 0.95 && confidence !== "low") return "buy";
  if (lowerBound > 0.6) return "caution";
  return "avoid";
}

export function computeScore(agg: SampleAggregate): Score {
  const base =
    WEIGHTS.schema * agg.schemaPassRate +
    WEIGHTS.staleness * agg.stalenessPassRate +
    WEIGHTS.latency * agg.latencyPassRate;

  // Every upheld claim is a proven violation, not an observation. It multiplies
  // the score down rather than just nudging an average.
  const claimPenalty =
    agg.samples === 0 ? 1 : Math.max(0, 1 - agg.upheldClaims / agg.samples);

  const reliability = agg.samples === 0 ? 0 : base * claimPenalty;

  const { lower, upper } = wilsonInterval(agg.passes, agg.samples);
  // Proven violations pull the bound down too — they are facts, not estimates.
  const lowerBound = agg.samples === 0 ? 0 : lower * claimPenalty;
  const confidence = confidenceFor(agg.samples, upper - lower);

  return {
    reliability: round4(reliability),
    reliabilityLower: round4(lowerBound),
    reliabilityUpper: round4(agg.samples === 0 ? 1 : upper),
    confidence,
    recommendation: recommendationFor(lowerBound, confidence, {
      samples: agg.samples,
      upheldClaims: agg.upheldClaims,
    }),
    breakdown: {
      schema: round4(agg.schemaPassRate),
      staleness: round4(agg.stalenessPassRate),
      latency: round4(agg.latencyPassRate),
      claimPenalty: round4(claimPenalty),
    },
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * How many failed calls this provider's remaining bond can actually cover.
 * This is the number an agent cares about: an enormous reliability score behind
 * a bond of zero is worth nothing.
 */
export function coverageCalls(bondMicro: number, priceMicro: number): number {
  const perClaim = priceMicro * (1 + env.slashMultiplier);
  if (perClaim <= 0) return 0;
  return Math.floor(bondMicro / perClaim);
}

export type ScoreRecord = {
  provider: string;
  label: string;
  endpoint: string;
  network: string;
  asset: { id: number; symbol: string; decimals: number };
  price_micro: number;
  price: number;
  bond_micro: number;
  bond: number;
  coverage_calls: number;
  active: boolean;
  sla: {
    max_staleness_s: number;
    max_latency_ms: number;
    sla_hash: string;
    required_fields: string[];
  };
  observed: {
    samples: number;
    passes: number;
    window: string;
    recent_samples_6h: number;
    p95_latency_ms: number;
    schema_pass_rate: number;
    staleness_pass_rate: number;
    latency_pass_rate: number;
    signature_pass_rate: number;
  };
  onchain: {
    app_id: number;
    success_count: number;
    claim_count: number;
    slashed_micro: number;
    slashed: number;
  };
  disputes: { filed: number; upheld: number; slashed_micro: number; slashed: number };
  reliability: number;
  /** What the evidence actually supports at 95%. The number to act on. */
  reliability_lower_bound: number;
  reliability_upper_bound: number;
  breakdown: ScoreBreakdown;
  confidence: Confidence;
  recommendation: Recommendation;
  as_of: string;
};

export const REQUIRED_FIELDS = ["symbol", "price", "data_timestamp"] as const;

export function buildScoreRecord(args: {
  label: string;
  endpoint: string;
  onchain: ProviderState;
  agg: SampleAggregate;
  appId: number;
}): ScoreRecord {
  const { label, endpoint, onchain, agg, appId } = args;
  const score = computeScore(agg);

  return {
    provider: onchain.address,
    label,
    endpoint,
    network: env.networkCaip2,
    asset: { id: env.assetId, symbol: env.assetSymbol, decimals: env.assetDecimals },
    price_micro: onchain.priceMicro,
    price: fromMicro(onchain.priceMicro),
    bond_micro: onchain.bondMicro,
    bond: fromMicro(onchain.bondMicro),
    coverage_calls: coverageCalls(onchain.bondMicro, onchain.priceMicro),
    active: onchain.active,
    sla: {
      max_staleness_s: onchain.maxStaleness,
      max_latency_ms: onchain.maxLatencyMs,
      sla_hash: `0x${onchain.slaHash.toString("hex")}`,
      required_fields: [...REQUIRED_FIELDS],
    },
    observed: {
      samples: agg.samples,
      passes: agg.passes,
      window: "24h",
      recent_samples_6h: agg.recentSamples,
      p95_latency_ms: agg.p95LatencyMs,
      schema_pass_rate: round4(agg.schemaPassRate),
      staleness_pass_rate: round4(agg.stalenessPassRate),
      latency_pass_rate: round4(agg.latencyPassRate),
      signature_pass_rate: round4(agg.sigPassRate),
    },
    onchain: {
      app_id: appId,
      success_count: onchain.successCount,
      claim_count: onchain.claimCount,
      slashed_micro: onchain.slashedMicro,
      slashed: fromMicro(onchain.slashedMicro),
    },
    disputes: {
      filed: onchain.claimCount,
      upheld: onchain.claimCount, // a claim only lands on chain if it was proven
      slashed_micro: onchain.slashedMicro,
      slashed: fromMicro(onchain.slashedMicro),
    },
    reliability: score.reliability,
    reliability_lower_bound: score.reliabilityLower,
    reliability_upper_bound: score.reliabilityUpper,
    breakdown: score.breakdown,
    confidence: score.confidence,
    recommendation: score.recommendation,
    as_of: new Date().toISOString(),
  };
}
