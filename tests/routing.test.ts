/**
 * The routing policy is the product. These tests pin down the three behaviours
 * the pitch depends on: a new bonded provider gets traffic, a proven cheat
 * stops getting traffic, and an unbonded provider is never paid at all.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  selectProvider,
  EXPLORE_SAMPLES,
  needsMonitoring,
  MONITOR_RATIO,
} from "../src/lib/recourse-client.ts";
import type { ScoreRecord } from "../src/lib/scoring.ts";

function provider(over: Partial<ScoreRecord> & { provider: string }): ScoreRecord {
  const base: ScoreRecord = {
    provider: over.provider,
    label: over.provider,
    endpoint: `https://example.test/${over.provider}`,
    network: "algorand:test",
    asset: { id: 1, symbol: "USDC", decimals: 6 },
    price_micro: 1000,
    price: 0.001,
    bond_micro: 100_000,
    bond: 0.1,
    coverage_calls: 10,
    active: true,
    counterparties: {
      distinct_payers: 1, observed_payments: 0, self_payments: 0,
      top_payer_share: 0, single_source: true,
    },
    sla: { max_staleness_s: 60, max_latency_ms: 8000, sla_hash: "0x00", required_fields: [] },
    observed: {
      samples: 0, passes: 0, window: "24h", recent_samples_6h: 0, p95_latency_ms: 100,
      schema_pass_rate: 1, staleness_pass_rate: 1, latency_pass_rate: 1, signature_pass_rate: 1,
      price_divergence: null, divergence_conclusive: false, divergence_checked: 0,
    },
    onchain: { app_id: 1, success_count: 0, claim_count: 0, slashed_micro: 0, slashed: 0 },
    disputes: { filed: 0, upheld: 0, slashed_micro: 0, slashed: 0 },
    reliability: 0,
    reliability_lower_bound: 0,
    reliability_upper_bound: 1,
    breakdown: { schema: 1, staleness: 1, latency: 1, claimPenalty: 1, consistencyPenalty: 1 },
    confidence: "low",
    recommendation: "unrated",
    as_of: new Date(0).toISOString(),
  };
  return { ...base, ...over };
}

const measured = (id: string, samples: number, lower: number, rec: ScoreRecord["recommendation"]) =>
  provider({
    provider: id,
    observed: { ...provider({ provider: id }).observed, samples, passes: samples },
    reliability_lower_bound: lower,
    recommendation: rec,
    confidence: "medium",
  });

describe("selectProvider", () => {
  test("explores a brand-new bonded provider rather than refusing it", () => {
    const s = selectProvider([provider({ provider: "A" })]);
    assert.equal(s.chosen?.provider, "A");
    assert.match(s.reason, /exploring/);
    assert.equal(s.candidates[0].eligible, true);
  });

  test("spreads exploration to the least-measured provider", () => {
    const a = provider({ provider: "A" });
    a.observed.samples = 4;
    const b = provider({ provider: "B" });
    b.observed.samples = 1;
    assert.equal(selectProvider([a, b]).chosen?.provider, "B");
  });

  test("never pays an unbonded provider, however good its score", () => {
    const broke = measured("A", 500, 0.99, "buy");
    broke.bond_micro = 0;
    broke.coverage_calls = 0;
    const s = selectProvider([broke]);
    assert.equal(s.chosen, null);
    assert.equal(s.candidates[0].eligible, false);
    assert.match(s.candidates[0].reason, /bond/);
  });

  test("never pays a provider the contract has deactivated", () => {
    const dead = measured("A", 500, 0.99, "buy");
    dead.active = false;
    dead.coverage_calls = 0;
    const s = selectProvider([dead]);
    assert.equal(s.chosen, null);
    assert.match(s.candidates[0].reason, /exhausted|deactivated/);
  });

  test("drops a provider once the evidence says avoid", () => {
    const good = measured("GOOD", 40, 0.9, "caution");
    const bad = measured("BAD", 40, 0, "avoid");
    const s = selectProvider([good, bad]);
    assert.equal(s.chosen?.provider, "GOOD");
    assert.equal(s.candidates.find(c => c.provider === "BAD")?.eligible, false);
  });

  test("keeps paying an unrated provider — the bond is what covers it", () => {
    const unrated = measured("A", EXPLORE_SAMPLES + 5, 0.7, "unrated");
    const s = selectProvider([unrated]);
    assert.equal(s.chosen?.provider, "A");
    assert.equal(s.candidates[0].eligible, true);
    assert.match(s.candidates[0].reason, /not yet conclusive/);
  });

  test("ranks on the lower bound, so more evidence wins a tie on pass rate", () => {
    // Sample counts deliberately kept inside MONITOR_RATIO of each other. The
    // monitoring floor pre-empts ranking by design, so a wider spread here
    // would test that instead and quietly stop covering the ranking rule.
    const thin = measured("THIN", 30, 0.81, "caution");
    const thick = measured("THICK", 200, 0.98, "buy");
    assert.ok(200 / 30 < MONITOR_RATIO, "fixture must not trip the monitoring floor");
    assert.equal(selectProvider([thin, thick]).chosen?.provider, "THICK");
  });

  test("stops buying entirely when nothing is eligible", () => {
    const a = measured("A", 40, 0, "avoid");
    const b = measured("B", 40, 0, "avoid");
    const s = selectProvider([a, b]);
    assert.equal(s.chosen, null);
    assert.match(s.reason, /stops buying/);
  });

  test("always reports a verdict for every candidate", () => {
    const s = selectProvider([provider({ provider: "A" }), measured("B", 40, 0, "avoid")]);
    assert.equal(s.candidates.length, 2);
    for (const c of s.candidates) assert.ok(c.reason.length > 0);
  });
});

/**
 * Exploitation alone makes the market unobservable.
 *
 * Cross-provider consistency is a statement about *disagreement*, so it can
 * only be computed from observations of several providers covering the same
 * moment. An agent that buys only from the current leader has nothing to
 * cross-check against, and a provider lying about time stops being merely
 * unproven and becomes undetectable.
 *
 * This is not hypothetical. In production the leader reached 181 samples while
 * two eligible providers sat frozen at 6 — one of them the forger — and every
 * provider reported divergence_checked = 0.
 *
 * The floor is stateless by design: it reads sample counts the agent already
 * has rather than tracking a cadence, so it self-corrects after a gap in
 * trading instead of drifting out of step.
 */
describe("monitoring floor", () => {
  test("triggers once the evidence base is more lopsided than the ratio", () => {
    assert.equal(needsMonitoring(181, 6), true);
    assert.equal(needsMonitoring(49, 6), true);
  });

  test("stays quiet while the spread is reasonable", () => {
    assert.equal(needsMonitoring(48, 6), false);
    assert.equal(needsMonitoring(10, 10), false);
    assert.equal(needsMonitoring(6, 6), false);
  });

  test("a provider with nothing at all is always worth a look", () => {
    assert.equal(needsMonitoring(1, 0), true);
  });

  test("the agent buys from the laggard, not the leader, when it fires", () => {
    const leader = measured("LEADER", 181, 0.98, "buy");
    const laggard = measured("LAGGARD", 6, 0.61, "unrated");
    const s = selectProvider([leader, laggard]);
    assert.equal(s.chosen?.provider, "LAGGARD");
    assert.match(s.reason, /monitoring/);
    // Monitoring is a purchase, not an exclusion — the leader stays eligible.
    assert.equal(s.candidates.find(c => c.provider === "LEADER")?.eligible, true);
  });

  test("it picks the least-measured of several laggards", () => {
    const s = selectProvider([
      measured("LEADER", 181, 0.98, "buy"),
      measured("MID", 20, 0.7, "caution"),
      measured("THINNEST", 6, 0.61, "unrated"),
    ]);
    assert.equal(s.chosen?.provider, "THINNEST");
  });

  test("with the spread closed it goes back to buying the best", () => {
    const s = selectProvider([
      measured("LEADER", 40, 0.98, "buy"),
      measured("LAGGARD", 30, 0.61, "unrated"),
    ]);
    assert.equal(s.chosen?.provider, "LEADER");
    assert.match(s.reason, /best of/);
  });

  test("it never resurrects a provider the agent has ruled out", () => {
    // Monitoring must not become a back door that sends money to a provider
    // already excluded for being unbonded or proven bad.
    const dead = measured("DRAINED", 6, 0, "avoid");
    const s = selectProvider([measured("LEADER", 181, 0.98, "buy"), dead]);
    assert.equal(s.chosen?.provider, "LEADER");
    assert.equal(s.candidates.find(c => c.provider === "DRAINED")?.eligible, false);
  });

  test("a lone eligible provider is still bought from", () => {
    const s = selectProvider([measured("ONLY", 181, 0.98, "buy")]);
    assert.equal(s.chosen?.provider, "ONLY");
  });
});
