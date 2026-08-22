/**
 * The forger case: a provider serving old data with a forged current timestamp
 * passes every cryptographic check, so this is the only thing that catches it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeConsistency } from "../src/lib/consistency.ts";
import type { SampleRow } from "../src/lib/db.ts";

/** A true price path: rises steadily, so a lag is visible as a price gap. */
const truePrice = (t: number) => 0.18 + (t % 3600) * 0.00002;

function sample(provider: string, claimedTs: number, price: number): SampleRow {
  return {
    provider, ts: new Date(claimedTs * 1000), http_status: 200, latency_ms: 100,
    schema_ok: true, stale_s: 0, sig_ok: true, staleness_ok: true, latency_ok: true,
    price, claimed_ts: claimedTs,
  };
}

/** now-anchored series for three providers with the demo's exact behaviours. */
/**
 * Four providers, sampled the way the agent actually calls them: a few seconds
 * apart, not minutes. Two are honest and fresh — a market needs a majority at
 * the same claimed moment or a disagreement is just a tie.
 */
function market(rounds: number, lagS = 2700) {
  const t0 = 1_800_000_000;
  const rows: SampleRow[] = [];
  for (let i = 0; i < rounds; i++) {
    const now = t0 + i * 20;
    rows.push(sample("HONEST", now, truePrice(now)));
    rows.push(sample("HONEST2", now, truePrice(now)));
    // honest about being stale: old price AND old timestamp — still truthful
    rows.push(sample("STALE", now - lagS, truePrice(now - lagS)));
    // forger: old price, timestamp claimed as now
    rows.push(sample("FORGER", now, truePrice(now - lagS)));
  }
  return rows;
}

describe("computeConsistency", () => {
  const stats = computeConsistency(market(12));

  test("the honest provider agrees with the market", () => {
    const s = stats.get("HONEST")!;
    assert.ok(s.checked > 0, "no comparable peer points");
    assert.ok(s.medianDivergence < 0.004, `divergence was ${s.medianDivergence}`);
  });

  test("a provider honest about being stale is NOT penalised", () => {
    // This is the distinction that matters: reporting an old price with an old
    // timestamp is truthful, and must not look like forgery.
    const s = stats.get("STALE");
    if (s && s.checked > 0) {
      assert.ok(s.medianDivergence < 0.004, `stale-but-honest flagged: ${s.medianDivergence}`);
    }
  });

  test("the forger disagrees with the market about its own claimed moment", () => {
    const s = stats.get("FORGER")!;
    assert.ok(s.checked > 0, "forger never got compared");
    assert.ok(s.medianDivergence > 0.004, `forger not detected: ${s.medianDivergence}`);
    assert.ok(s.consistent < s.checked, "forger should have inconsistent samples");
  });

  test("the forger is ranked as the worst offender", () => {
    const h = stats.get("HONEST")!.medianDivergence;
    const f = stats.get("FORGER")!.medianDivergence;
    assert.ok(f > h, `forger ${f} should diverge more than honest ${h}`);
  });

  test("declines to judge without enough peers", () => {
    const lonely = computeConsistency([sample("ALONE", 1_800_000_000, 0.18)]);
    assert.equal(lonely.size, 0, "one provider is not a market");
  });

  test("declines to judge a two-provider disagreement", () => {
    // A tie is not evidence. Convicting either side would be guessing, and the
    // median of two values is their midpoint, which makes both look half-wrong.
    const t = 1_800_000_000;
    const pair = computeConsistency([
      sample("A", t, 0.18), sample("B", t, 0.19),
      sample("A", t + 10, 0.18), sample("B", t + 10, 0.19),
    ]);
    assert.equal(pair.size, 0, "a two-provider disagreement is undecidable");
  });

  test("an honest majority outvotes a forger", () => {
    const t = 1_800_000_000;
    const rows = [];
    for (let i = 0; i < 8; i++) {
      const now = t + i * 20;
      rows.push(sample("H1", now, truePrice(now)));
      rows.push(sample("H2", now, truePrice(now)));
      rows.push(sample("LIAR", now, truePrice(now - 2700)));
    }
    const st = computeConsistency(rows);
    assert.ok(st.get("H1")!.medianDivergence < 0.004);
    assert.ok(st.get("H2")!.medianDivergence < 0.004);
    assert.ok(st.get("LIAR")!.medianDivergence > 0.004);
    assert.equal(st.get("LIAR")!.consistent, 0);
  });

  test("a handful of points is not conclusive", () => {
    const s = computeConsistency(market(1)).get("FORGER");
    if (s) assert.equal(s.conclusive, false, "should not convict on one round");
  });

  test("enough points becomes conclusive", () => {
    assert.equal(computeConsistency(market(12)).get("FORGER")!.conclusive, true);
  });

  test("ignores samples with no usable price", () => {
    const rows = market(6).map(r => ({ ...r, price: 0 }));
    assert.equal(computeConsistency(rows).size, 0);
  });
});
