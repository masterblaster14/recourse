/**
 * The agent must refuse to pay anyone other than the party whose collateral it
 * checked.
 *
 * Without this the registry is decorative: an agent looks up a provider's bond,
 * then pays whatever address the 402 happens to name. A compromised host could
 * swap in an attacker's address, collect real money under a bonded provider's
 * reputation, and leave nothing claimable — the bonded provider never signed a
 * thing, so no proof of breach can exist.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assertPaymentAcceptable, PaymentRefused } from "../src/lib/recourse-client.ts";

const BONDED = "T7X54PQA7EXDPIRKNV3PHQFGXILNG7H7LWHFM4PNWDN2AJOFIHLOUX2Q74";
const ATTACKER = "43YQYEJMOBYEQOU7KDEIZ6SVTYS4FFRTMROHJOTNPG6OH3VXPUFGPYPN6E";
const NETWORK = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";

function challenge(over: Partial<{ payTo: string; asset: string; amount: string; network: string }> = {}) {
  const body = {
    x402Version: 2,
    accepts: [{
      scheme: "exact",
      network: over.network ?? NETWORK,
      asset: over.asset ?? "10458941",
      amount: over.amount ?? "1000",
      payTo: over.payTo ?? BONDED,
    }],
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64");
}

const expect = { payTo: BONDED, assetId: 10458941, networkCaip2: NETWORK, maxAmountMicro: 5000 };

describe("assertPaymentAcceptable", () => {
  test("accepts a 402 that matches what the agent checked", () => {
    assert.doesNotThrow(() => assertPaymentAcceptable(challenge(), expect));
  });

  test("REFUSES a swapped payee — the core attack", () => {
    assert.throws(
      () => assertPaymentAcceptable(challenge({ payTo: ATTACKER }), expect),
      (e: Error) => e instanceof PaymentRefused && /payee/.test(e.message),
    );
  });

  test("refuses a different asset", () => {
    assert.throws(() => assertPaymentAcceptable(challenge({ asset: "31566704" }), expect), PaymentRefused);
  });

  test("refuses a different network", () => {
    assert.throws(() => assertPaymentAcceptable(challenge({ network: "eip155:8453" }), expect), PaymentRefused);
  });

  test("refuses a price above the cap", () => {
    assert.throws(
      () => assertPaymentAcceptable(challenge({ amount: "500000" }), expect),
      (e: Error) => e instanceof PaymentRefused && /exceeds the cap/.test(e.message),
    );
  });

  test("refuses an unreadable or absent challenge", () => {
    assert.throws(() => assertPaymentAcceptable(null, expect), PaymentRefused);
    assert.throws(() => assertPaymentAcceptable("not-base64-json", expect), PaymentRefused);
  });

  test("refuses a challenge advertising no options at all", () => {
    const empty = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [] })).toString("base64");
    assert.throws(() => assertPaymentAcceptable(empty, expect), PaymentRefused);
  });

  test("accepts when one of several options is acceptable", () => {
    const body = {
      x402Version: 2,
      accepts: [
        { scheme: "exact", network: "eip155:8453", asset: "x", amount: "1", payTo: ATTACKER },
        { scheme: "exact", network: NETWORK, asset: "10458941", amount: "1000", payTo: BONDED },
      ],
    };
    const h = Buffer.from(JSON.stringify(body)).toString("base64");
    assert.doesNotThrow(() => assertPaymentAcceptable(h, expect));
  });

  test("with no expectation set, anything is acceptable", () => {
    assert.doesNotThrow(() => assertPaymentAcceptable(challenge({ payTo: ATTACKER }), {}));
  });
});
