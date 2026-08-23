/**
 * Counterparty-weighted reputation.
 *
 * Reputation built on volume is trivially forged — a provider can pay itself
 * all day, and on a public chain that costs it only fees. Counting *distinct
 * counterparties* is what makes the number cost something, because each new
 * counterparty is somebody the provider does not control.
 *
 * The design decision worth defending is that this **caps confidence rather
 * than docking the score**. A brand-new honest provider has exactly one
 * customer; so does a provider quietly paying itself. A penalty cannot tell
 * them apart and would hit the honest one hardest — which is precisely the
 * incumbent-protecting behaviour this project exists to remove. Declining to
 * claim *high* confidence states the true thing (our evidence is narrow)
 * without pretending to know which case we are looking at.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { counterpartyStats, emptyCounterparties } from "../src/lib/db.ts";
import { capConfidenceByCounterparties } from "../src/lib/scoring.ts";

const P = "PROVIDER_ADDRESS";
const pay = (payer: string, provider = P) => ({ provider, payer });

describe("counterpartyStats", () => {
  test("counts distinct payers, not payments", () => {
    const s = counterpartyStats(
      [pay("alice"), pay("alice"), pay("alice"), pay("bob")],
      P,
    );
    assert.equal(s.distinctPayers, 2);
    assert.equal(s.observedPayments, 4);
  });

  test("excludes a provider paying itself entirely", () => {
    // Not weak evidence of quality — no evidence at all.
    const s = counterpartyStats([pay(P), pay(P), pay("alice")], P);
    assert.equal(s.selfPayments, 2);
    assert.equal(s.distinctPayers, 1, "self-payment must not count as a counterparty");
    assert.equal(s.observedPayments, 1, "self-payment must not inflate volume");
  });

  test("self-dealing alone yields no counterparties at all", () => {
    const s = counterpartyStats([pay(P), pay(P), pay(P), pay(P)], P);
    assert.equal(s.distinctPayers, 0);
    assert.equal(s.observedPayments, 0);
    assert.equal(s.selfPayments, 4);
  });

  test("an unattributable payer is not allowed to look like a distinct party", () => {
    const s = counterpartyStats([pay("unknown"), pay(""), pay("alice")], P);
    assert.equal(s.distinctPayers, 1);
  });

  test("ignores payments made to a different provider", () => {
    const s = counterpartyStats(
      [pay("alice"), { provider: "SOMEONE_ELSE", payer: "bob" }],
      P,
    );
    assert.equal(s.distinctPayers, 1);
    assert.equal(s.observedPayments, 1);
  });

  test("reports how concentrated the volume is", () => {
    const rows = [...Array(9)].map(() => pay("whale")).concat([pay("minnow")]);
    const s = counterpartyStats(rows, P);
    assert.equal(s.distinctPayers, 2);
    assert.equal(s.topPayerShare, 0.9);
  });

  test("an even split is reported as such", () => {
    const s = counterpartyStats([pay("a"), pay("b"), pay("c"), pay("d")], P);
    assert.equal(s.topPayerShare, 0.25);
  });

  test("no payments is zero, not a division by zero", () => {
    const s = counterpartyStats([], P);
    assert.deepEqual(s, emptyCounterparties());
    assert.equal(Number.isFinite(s.topPayerShare), true);
  });
});

describe("capConfidenceByCounterparties", () => {
  test("a single counterparty cannot support high confidence", () => {
    assert.equal(capConfidenceByCounterparties("high", { distinctPayers: 1 }), "medium");
    assert.equal(capConfidenceByCounterparties("high", { distinctPayers: 0 }), "medium");
  });

  test("two independent payers unlock it", () => {
    assert.equal(capConfidenceByCounterparties("high", { distinctPayers: 2 }), "high");
  });

  test("it caps and never demotes further", () => {
    // The point is to stop over-claiming, not to punish. medium and low pass
    // through untouched however narrow the counterparty base.
    assert.equal(capConfidenceByCounterparties("medium", { distinctPayers: 0 }), "medium");
    assert.equal(capConfidenceByCounterparties("low", { distinctPayers: 0 }), "low");
  });

  test("medium still permits a buy, so a thin market is not a barrier", () => {
    // recommendationFor requires confidence !== "low" for "buy". Capping at
    // medium must therefore never cost an honest new provider its traffic.
    const capped = capConfidenceByCounterparties("high", { distinctPayers: 1 });
    assert.notEqual(capped, "low");
  });
});
