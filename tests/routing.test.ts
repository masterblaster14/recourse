/**
 * The routing policy is the product. These tests pin down the three behaviours
 * the pitch depends on: a new bonded provider gets traffic, a proven cheat
 * stops getting traffic, and an unbonded provider is never paid at all.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { selectProvider, EXPLORE_SAMPLES } from "../src/lib/recourse-client.ts";
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
    const thin = measured("THIN", 16, 0.81, "caution");
    const thick = measured("THICK", 200, 0.98, "buy");
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
