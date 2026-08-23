/**
 * The scoring rules decide where unattended money goes, so the behaviour that
 * matters most is what the score says when it does *not* know enough.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeScore,
  confidenceFor,
  decisiveViolations,
  coverageCalls,
  recommendationFor,
  wilsonInterval,
} from "../src/lib/scoring.ts";
import type { SampleAggregate } from "../src/lib/db.ts";

/** All-clean aggregate with `n` samples, unless overridden. */
function agg(n: number, passes = n, upheldClaims = 0): SampleAggregate {
  const rate = n === 0 ? 0 : passes / n;
  return {
    samples: n,
    passes,
    // Uniform weights, so the effective size is just the raw count.
    effectiveSamples: n,
    weightedPassRate: n === 0 ? 0 : passes / n,
    recentSamples: n,
    schemaPassRate: n === 0 ? 0 : 1,
    stalenessPassRate: rate,
    latencyPassRate: n === 0 ? 0 : 1,
    sigPassRate: n === 0 ? 0 : 1,
    p95LatencyMs: 120,
    upheldClaims,
  };
}

describe("wilsonInterval", () => {
  test("no data means no knowledge, not zero reliability", () => {
    assert.deepEqual(wilsonInterval(0, 0), { lower: 0, upper: 1 });
  });

  test("one perfect sample is a very wide interval", () => {
    const { lower, upper } = wilsonInterval(1, 1);
    assert.ok(lower > 0.19 && lower < 0.23, `lower was ${lower}`);
    assert.equal(upper, 1);
  });

  test("the interval tightens as evidence accumulates", () => {
    const widths = [1, 8, 16, 50, 200].map(n => {
      const w = wilsonInterval(n, n);
      return w.upper - w.lower;
    });
    for (let i = 1; i < widths.length; i++) {
      assert.ok(widths[i] < widths[i - 1], `width did not shrink at index ${i}: ${widths}`);
    }
  });

  test("known values", () => {
    assert.ok(Math.abs(wilsonInterval(16, 16).lower - 0.806) < 0.005);
    assert.ok(Math.abs(wilsonInterval(50, 50).lower - 0.929) < 0.005);
    assert.ok(Math.abs(wilsonInterval(200, 200).lower - 0.981) < 0.005);
  });

  test("all-failure gives a low upper bound", () => {
    const { lower, upper } = wilsonInterval(0, 10);
    assert.equal(lower, 0);
    assert.ok(upper < 0.3, `upper was ${upper}`);
  });

  test("bounds always stay inside [0,1]", () => {
    for (const [s, n] of [[0, 1], [1, 1], [3, 7], [99, 100], [0, 1000]] as const) {
      const { lower, upper } = wilsonInterval(s, n);
      assert.ok(lower >= 0 && lower <= 1 && upper >= 0 && upper <= 1);
      assert.ok(lower <= upper);
    }
  });
});

describe("confidenceFor", () => {
  test("needs both enough samples and a tight interval", () => {
    assert.equal(confidenceFor(200, 0.02), "high");
    assert.equal(confidenceFor(200, 0.5), "low", "wide interval cannot be high confidence");
    assert.equal(confidenceFor(3, 0.02), "low", "too few samples cannot be high confidence");
    assert.equal(confidenceFor(20, 0.2), "medium");
  });
});

describe("recommendationFor", () => {
  const noClaims = (samples: number) => ({ samples, upheldClaims: 0 });

  test("unmeasured is unrated, never avoid", () => {
    assert.equal(recommendationFor(0, "low", noClaims(0)), "unrated");
    assert.equal(recommendationFor(0.21, "low", noClaims(1)), "unrated");
    assert.equal(recommendationFor(0.68, "low", noClaims(8)), "unrated");
  });

  test("a single upheld claim overrides the evidence test immediately", () => {
    assert.equal(recommendationFor(0, "low", { samples: 1, upheldClaims: 1 }), "avoid");
    assert.equal(recommendationFor(0, "low", { samples: 3, upheldClaims: 1 }), "avoid");
  });

  test("buy requires both a high lower bound and real confidence", () => {
    assert.equal(recommendationFor(0.98, "high", noClaims(200)), "buy");
    assert.equal(recommendationFor(0.98, "low", noClaims(200)), "unrated");
    assert.equal(recommendationFor(0.93, "high", noClaims(50)), "caution");
  });
});

describe("computeScore", () => {
  test("zero samples scores zero and reads as unrated", () => {
    const s = computeScore(agg(0));
    assert.equal(s.reliability, 0);
    assert.equal(s.reliabilityLower, 0);
    assert.equal(s.confidence, "low");
    assert.equal(s.recommendation, "unrated");
  });

  test("a perfect provider climbs unrated -> caution -> buy as evidence grows", () => {
    assert.equal(computeScore(agg(1)).recommendation, "unrated");
    assert.equal(computeScore(agg(16)).recommendation, "caution");
    assert.equal(computeScore(agg(200)).recommendation, "buy");
  });

  test("the lower bound is never above the point estimate of the pass rate", () => {
    for (const n of [1, 5, 16, 50, 200]) {
      const s = computeScore(agg(n));
      assert.ok(s.reliabilityLower <= 1);
      assert.ok(s.reliabilityLower <= s.reliabilityUpper);
    }
  });

  test("upheld claims drive the score down hard", () => {
    const clean = computeScore(agg(10, 10, 0));
    const dirty = computeScore(agg(10, 0, 10));
    assert.ok(dirty.reliability < clean.reliability);
    assert.equal(dirty.reliabilityLower, 0);
    assert.equal(dirty.recommendation, "avoid");
    assert.equal(dirty.breakdown.claimPenalty, 0);
  });

  test("a provider that always breaches staleness cannot be recommended", () => {
    const s = computeScore(agg(6, 0, 6));
    assert.equal(s.recommendation, "avoid");
  });
});

describe("coverageCalls", () => {
  test("counts how many upheld claims the bond can actually pay for", () => {
    // price 1000, slash multiplier 9 => 10000 per claim
    assert.equal(coverageCalls(100_000, 1000), 10);
    assert.equal(coverageCalls(19_999, 1000), 1);
    assert.equal(coverageCalls(9_999, 1000), 0);
    assert.equal(coverageCalls(0, 1000), 0);
  });

  test("a zero price cannot divide by zero", () => {
    assert.equal(coverageCalls(100_000, 0), 0);
  });
});

/**
 * A detected forger must not be reported as "unrated".
 *
 * `unrated` means "not enough evidence to say anything", and it exists so a
 * brand-new honest provider is not treated as though it had been caught. A
 * provider that conclusively disagrees with the rest of the market about a
 * moment it named itself is the opposite case: we have measured it and found
 * it lying about time. Reporting that as an absence of information would hand
 * an agent exactly the wrong conclusion.
 *
 * This regressed once already. `computeScore` applied the adjustment and
 * `buildScoreRecord` — which recomputes the recommendation against a
 * counterparty-capped confidence — did not, so a forger with reliability
 * crushed to zero still displayed as `unrated`. Both now share
 * `decisiveViolations`, and these tests hold both ends.
 */
describe("a conclusive market divergence is evidence, not silence", () => {
  const agg = (over: Partial<SampleAggregate> = {}): SampleAggregate => ({
    samples: 6, passes: 6, effectiveSamples: 6, weightedPassRate: 1,
    recentSamples: 6, schemaPassRate: 1, stalenessPassRate: 1, latencyPassRate: 1,
    sigPassRate: 1, p95LatencyMs: 100, upheldClaims: 0, ...over,
  });

  // ~4.4% is the measured median for a 45-minute lag on this price series.
  const divergent = { checked: 6, consistent: 0, medianDivergence: 0.044, conclusive: true };
  const agreeing = { checked: 6, consistent: 6, medianDivergence: 0.0038, conclusive: true };

  test("counts a conclusive divergence alongside proven claims", () => {
    assert.equal(decisiveViolations(agg({ consistency: divergent })), 1);
  });

  test("a provider agreeing with the market is not penalised", () => {
    assert.equal(decisiveViolations(agg({ consistency: agreeing })), 0);
  });

  test("an inconclusive divergence stays silent — too little evidence to act", () => {
    const early = { checked: 2, consistent: 0, medianDivergence: 0.05, conclusive: false };
    assert.equal(decisiveViolations(agg({ consistency: early })), 0);
  });

  test("it adds to real claims rather than replacing them", () => {
    assert.equal(decisiveViolations(agg({ upheldClaims: 3, consistency: divergent })), 4);
  });

  test("the forger does not read as unrated, despite low confidence", () => {
    // Six samples is "low" confidence, which is normally an automatic unrated.
    const s = computeScore(agg({ consistency: divergent }));
    assert.equal(s.confidence, "low");
    assert.notEqual(s.recommendation, "unrated",
      "a measured forger must not be reported as unmeasured");
    assert.equal(s.recommendation, "avoid");
  });

  test("an honest provider with the same sample count still reads unrated", () => {
    const s = computeScore(agg({ consistency: agreeing }));
    assert.equal(s.recommendation, "unrated",
      "thin evidence about an honest provider must stay unrated, not avoid");
  });
});
