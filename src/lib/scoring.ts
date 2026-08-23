/**
 * Reliability scoring.
 *
 * The important design decision here is `confidence`. A provider with one
 * successful call is not 100% reliable, it is unmeasured, and the score has to
 * say so out loud. Without that, every brand-new provider looks perfect and the
 * score is worse than useless — it actively misleads the agent buying from it.
 */
import { env, fromMicro } from "../env.ts";
import { emptyCounterparties, type CounterpartyStats, type SampleAggregate } from "./db.ts";
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
  /** 1.0 = agrees with the market; lower = disagrees about its own timestamps. */
  consistencyPenalty: number;
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

/**
 * Narrow the confidence when every observation traces back to one payer.
 *
 * Confidence answers "how much do we know", and a thousand calls from a single
 * counterparty is one relationship observed a thousand times, not a thousand
 * independent observations. The statistics cannot see that — the interval only
 * knows how many trials there were, not who ran them.
 *
 * This caps rather than penalises, and the distinction is the whole design. A
 * brand-new provider legitimately has one customer; so does a provider quietly
 * paying itself. Docking the score would punish both, and the honest one is
 * exactly who this project exists to let in. Declining to claim *high*
 * confidence says the true thing — our evidence is narrow — without pretending
 * to know which of the two we are looking at.
 *
 * `medium` still permits a `buy`, so a thin market is not a barrier to traffic.
 */
export function capConfidenceByCounterparties(
  confidence: Confidence,
  counterparties: { distinctPayers: number },
): Confidence {
  if (confidence === "high" && counterparties.distinctPayers <= 1) return "medium";
  return confidence;
}

/**
 * Findings decisive enough that "not enough evidence" would be a false answer.
 *
 * An upheld claim is proof. A conclusive disagreement with the rest of the
 * market about a moment the provider itself named is not proof — it never
 * touches the bond — but it is not an absence of information either, and
 * reporting it as `unrated` would tell an agent we know nothing about a
 * provider we have measured and found to be lying about time.
 *
 * Shared by computeScore and buildScoreRecord because both decide a
 * recommendation, and having only one of them apply it is exactly the bug that
 * left a detected forger reading `unrated` on the dashboard.
 */
export function decisiveViolations(agg: SampleAggregate): number {
  const c = agg.consistency;
  const consistencyRate = c && c.checked > 0 ? c.consistent / c.checked : 1;
  return agg.upheldClaims + (c?.conclusive && consistencyRate < 0.5 ? 1 : 0);
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

  // A provider that disagrees with the rest of the market about what the price
  // was at a moment it itself named is serving something other than what it
  // claims. That is evidence, not proof — so it caps the score and removes the
  // provider from routing, and never touches the bond.
  const c = agg.consistency;
  const consistencyRate = c && c.checked > 0 ? c.consistent / c.checked : 1;
  const consistencyPenalty = c?.conclusive ? consistencyRate : 1;

  const reliability = agg.samples === 0 ? 0 : base * claimPenalty * consistencyPenalty;

  // Same basis as the weighted rates above: weighted successes over the Kish
  // effective sample size. Feeding raw counts here while the composite used
  // recency-weighted rates put two different denominators side by side under
  // labels that implied one.
  const n = agg.effectiveSamples;
  const { lower, upper } = wilsonInterval(agg.weightedPassRate * n, n);

  // Proven violations pull the bound down too — they are facts, not estimates.
  const lowerBound = agg.samples === 0 ? 0 : lower * claimPenalty * consistencyPenalty;
  const confidence = confidenceFor(agg.effectiveSamples, upper - lower);

  return {
    reliability: round4(reliability),
    reliabilityLower: round4(lowerBound),
    reliabilityUpper: round4(agg.samples === 0 ? 1 : upper),
    confidence,
    recommendation: recommendationFor(lowerBound, confidence, {
      samples: agg.samples,
      upheldClaims: decisiveViolations(agg),
    }),
    breakdown: {
      schema: round4(agg.schemaPassRate),
      staleness: round4(agg.stalenessPassRate),
      latency: round4(agg.latencyPassRate),
      claimPenalty: round4(claimPenalty),
      consistencyPenalty: round4(consistencyPenalty),
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
  /** Who has actually paid this provider. Reported as facts, never as a
   *  penalty — see capConfidenceByCounterparties. */
  counterparties: {
    distinct_payers: number;
    observed_payments: number;
    self_payments: number;
    top_payer_share: number;
    single_source: boolean;
  };
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
    /** Median relative disagreement with other providers about the price at a
     *  moment this provider itself named. Null until peers exist. */
    price_divergence: number | null;
    divergence_conclusive: boolean;
    divergence_checked: number;
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
  counterparties?: CounterpartyStats;
}): ScoreRecord {
  const { label, endpoint, onchain, agg, appId } = args;
  const cp = args.counterparties ?? emptyCounterparties();
  const score = computeScore(agg);
  const confidence = capConfidenceByCounterparties(score.confidence, cp);

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
    counterparties: {
      distinct_payers: cp.distinctPayers,
      observed_payments: cp.observedPayments,
      self_payments: cp.selfPayments,
      top_payer_share: round4(cp.topPayerShare),
      single_source: cp.distinctPayers <= 1,
    },
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
      price_divergence: agg.consistency?.medianDivergence ?? null,
      divergence_conclusive: agg.consistency?.conclusive ?? false,
      divergence_checked: agg.consistency?.checked ?? 0,
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
    confidence,
    recommendation: recommendationFor(score.reliabilityLower, confidence, {
      samples: agg.samples,
      upheldClaims: decisiveViolations(agg),
    }),
    as_of: new Date().toISOString(),
  };
}
