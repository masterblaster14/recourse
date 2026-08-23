/**
 * The agent's own spending policy — protection against a compromised,
 * prompt-injected or simply buggy agent.
 *
 * A per-payment cap is not enough on its own. An agent that has been talked
 * into buying something does not need to overpay once; it only needs to keep
 * paying. Every limit here is deterministic and checked against the agent's own
 * ledger before any network call, so it holds regardless of *why* the agent
 * started misbehaving.
 *
 * What these do NOT do is judge intent. Deciding whether a reasoning chain was
 * manipulated needs trace capture and a model — a different layer, named in the
 * README's security model rather than half-answered here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  settledAmountMicro,
  defaultSpendPolicy,
  PolicyViolation,
  RecourseClient,
  type SpendPolicy,
} from "../src/lib/recourse-client.ts";
import algosdk from "algosdk";

const MNEMONIC = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);

function agent(over: Partial<SpendPolicy> = {}): RecourseClient {
  return new RecourseClient(MNEMONIC, { ...defaultSpendPolicy(), ...over });
}

/** Nothing here should ever reach the network: every case stops before that. */
const URL_OK = "https://recourse-api-production.up.railway.app/feed/compliant";

describe("spend policy", () => {
  test("a single payment above the ceiling is refused", async () => {
    const a = agent({ maxPerPaymentMicro: 1000 });
    await assert.rejects(
      () => a.pay(URL_OK, { maxAmountMicro: 50_000 }),
      (e: Error) => e instanceof PolicyViolation && /per-payment-cap/.test(e.message),
    );
  });

  test("the session budget stops a run of individually-fine payments", async () => {
    // The prompt-injection shape: this payment is individually fine — well
    // under the per-payment ceiling — and is stopped purely by the running
    // total. That is the case a per-payment cap alone cannot catch.
    const a = agent({ sessionBudgetMicro: 500, maxPerPaymentMicro: 1000 });
    await assert.rejects(
      () => a.pay(URL_OK, { maxAmountMicro: 800 }),
      (e: Error) => e instanceof PolicyViolation && /session-budget/.test(e.message),
    );
    assert.equal(a.spend().halted, true, "budget breach must stop the agent, not just skip");
  });

  test("once halted it will not spend again, even within limits", async () => {
    const a = agent({ sessionBudgetMicro: 100 });
    await assert.rejects(() => a.pay(URL_OK, { maxAmountMicro: 1000 }), PolicyViolation);
    await assert.rejects(
      () => a.pay(URL_OK, { maxAmountMicro: 1 }),
      (e: Error) => e instanceof PolicyViolation && /halted/.test(e.message),
    );
  });

  test("it will not pay a host outside its allow-list", async () => {
    const a = agent({ allowedHosts: ["recourse-api-production.up.railway.app"] });
    await assert.rejects(
      () => a.pay("https://attacker.example/drain", { maxAmountMicro: 1 }),
      (e: Error) => e instanceof PolicyViolation && /host-not-allowed/.test(e.message),
    );
    assert.equal(a.spend().halted, true);
  });

  test("an empty allow-list means no host restriction", async () => {
    const a = agent({ allowedHosts: [], sessionBudgetMicro: 0 });
    // Budget stops it, which proves the host check let it through first.
    await assert.rejects(
      () => a.pay("https://anywhere.example/x", { maxAmountMicro: 1 }),
      (e: Error) => /session-budget/.test(e.message),
    );
  });

  test("an unparseable URL is a stop, not a crash", async () => {
    const a = agent({ allowedHosts: ["example.com"] });
    await assert.rejects(
      () => a.pay("not a url", { maxAmountMicro: 1 }),
      (e: Error) => e instanceof PolicyViolation && /bad-url/.test(e.message),
    );
  });

  test("the rate limit bounds a runaway loop in time", async () => {
    const a = agent({ maxPaymentsPerMinute: 0 });
    await assert.rejects(
      () => a.pay(URL_OK, { maxAmountMicro: 1 }),
      (e: Error) => e instanceof PolicyViolation && /rate-limit/.test(e.message),
    );
  });

  test("the ledger starts clean and can be reset", () => {
    const a = agent();
    const l = a.spend();
    assert.equal(l.spentMicro, 0);
    assert.equal(l.payments, 0);
    assert.equal(l.halted, false);
    a.resetLedger();
    assert.equal(a.spend().halted, false);
  });

  test("defaults are finite — an agent is never handed an open cheque", () => {
    const p = defaultSpendPolicy();
    assert.ok(p.maxPerPaymentMicro > 0 && Number.isFinite(p.maxPerPaymentMicro));
    assert.ok(p.sessionBudgetMicro > 0 && Number.isFinite(p.sessionBudgetMicro));
    assert.ok(p.maxPaymentsPerMinute > 0 && Number.isFinite(p.maxPaymentsPerMinute));
    assert.ok(p.haltAfterConsecutiveRefusals > 0);
  });
});

describe("high-value approval", () => {
  test("an unusually large payment stops and asks for a human", async () => {
    const a = agent({ requireApprovalAboveMicro: 5_000, maxPerPaymentMicro: 1_000_000 });
    await assert.rejects(
      () => a.pay(URL_OK, { maxAmountMicro: 60_000 }),
      (e: Error) => e instanceof PolicyViolation && /needs-human-approval/.test(e.message),
    );
    assert.equal(a.spend().halted, true);
  });

  test("routine payments still settle without anyone being asked", async () => {
    // Below the threshold the agent is fully autonomous; the budget stops it,
    // which proves the approval gate let it through.
    const a = agent({ requireApprovalAboveMicro: 5_000, sessionBudgetMicro: 0 });
    await assert.rejects(
      () => a.pay(URL_OK, { maxAmountMicro: 1000 }),
      (e: Error) => /session-budget/.test(e.message),
    );
  });
});

/**
 * The session budget is only a control if it counts real money.
 *
 * `maxAmountMicro` is a *tolerance* — five times list price, so a small price
 * change does not strand the agent mid-run. Charging the budget that figure
 * made every payment look five times its true size: the agent halted after 50
 * calls against a budget that should have allowed 250, and every reported
 * spend figure was 5x reality. The pre-flight check still uses the ceiling,
 * which is right, because the price is not known until the 402 arrives.
 */
describe("settled amount booked against the budget", () => {
  const expect1000 = { exactAmountMicro: 1000, maxAmountMicro: 5000 };

  test("prefers what the chain says moved over what either party intended", () => {
    const check = { verified: true, reason: "ok", amountMicro: 1000 };
    assert.equal(settledAmountMicro(check, expect1000), 1000);
  });

  test("books the agreed price when there is no chain confirmation", () => {
    assert.equal(settledAmountMicro(null, expect1000), 1000);
    assert.equal(settledAmountMicro(undefined, expect1000), 1000);
  });

  test("never books the tolerance ceiling when the real price is known", () => {
    assert.notEqual(settledAmountMicro(null, expect1000), 5000);
  });

  test("ignores an unverified settlement rather than trusting its figure", () => {
    // A facilitator reporting a number the chain does not corroborate must not
    // be the thing that moves our books.
    const bogus = { verified: false, reason: "receiver mismatch", amountMicro: 999_999 };
    assert.equal(settledAmountMicro(bogus, expect1000), 1000);
  });

  test("falls back to the ceiling only when nothing better exists", () => {
    assert.equal(settledAmountMicro(null, { maxAmountMicro: 5000 }), 5000);
    assert.equal(settledAmountMicro(null, {}), 0);
  });

  test("a full session at list price stays inside the stated budget", () => {
    // The regression in one line: 250 calls at 1000 micro is exactly the
    // 250000 budget. Booking the ceiling would have halted at 50.
    const budget = 250_000;
    let spent = 0;
    let calls = 0;
    while (spent + 1000 <= budget) {
      spent += settledAmountMicro({ verified: true, reason: "ok", amountMicro: 1000 }, expect1000);
      calls++;
    }
    assert.equal(calls, 250);
    assert.equal(spent, budget);
  });
});
