/**
 * Resource binding, asserted rather than assumed.
 *
 * "Five Attacks on x402 Agentic Payment Protocol" (Li, Wang & Wang) names
 * single-use, resource-bound payment claims as mitigation M3: a payment quoted
 * for one resource must not be spendable on another.
 *
 * On the AVM `exact` scheme the signed payment is an Algorand asset transfer,
 * and the facilitator checks receiver, amount, asset and network against the
 * quoted requirements. It does not check the resource, because no resource
 * identifier is carried in the transaction. What actually separates our routes
 * is that each one demands a different receiver — so a payment quoted for
 * /score fails `receiver !== requirements.payTo` when presented at /feed.
 *
 * That is a real defence, but it is a property of the address layout rather
 * than of the protocol, and it would disappear the moment two routes shared a
 * payee. These tests exist so that change cannot be made quietly.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildRoutes, paidPaths, payeeCollisions } from "../src/x402.ts";

describe("payeeCollisions", () => {
  test("accepts a table where every route pays a different address", () => {
    const routes = {
      "GET /score": { accepts: [{ payTo: "AAA" }] },
      "GET /feed/one": { accepts: [{ payTo: "BBB" }] },
      "GET /feed/two": { accepts: [{ payTo: "CCC" }] },
    };
    assert.deepEqual(payeeCollisions(routes), []);
  });

  test("catches two routes sharing a payee", () => {
    const routes = {
      "GET /score": { accepts: [{ payTo: "SAME" }] },
      "GET /feed/one": { accepts: [{ payTo: "SAME" }] },
    };
    const found = payeeCollisions(routes);
    assert.equal(found.length, 1);
    assert.match(found[0], /SAME/);
  });

  test("ignores unset addresses — that is preflight's job, not a collision", () => {
    const routes = {
      "GET /a": { accepts: [{ payTo: "" }] },
      "GET /b": { accepts: [{ payTo: "" }] },
      "GET /c": { accepts: [{}] },
    };
    assert.deepEqual(payeeCollisions(routes), []);
  });

  test("a route offering the same payee twice is not a cross-route collision", () => {
    const routes = {
      "GET /score": { accepts: [{ payTo: "AAA" }, { payTo: "AAA" }] },
      "GET /feed": { accepts: [{ payTo: "BBB" }] },
    };
    assert.deepEqual(payeeCollisions(routes), []);
  });
});

describe("the live route table", () => {
  test("builds without a payee collision", () => {
    // buildRoutes throws on collision, so reaching this line is the assertion.
    assert.ok(Object.keys(buildRoutes()).length > 0);
  });

  test("every configured payee is distinct", () => {
    const routes = buildRoutes() as unknown as Record<string, { accepts?: { payTo?: string }[] }>;
    const payees = Object.values(routes)
      .flatMap(r => r.accepts ?? [])
      .map(a => a.payTo)
      .filter((p): p is string => Boolean(p));
    assert.equal(new Set(payees).size, payees.length, "two paid routes share a payee");
  });

  test("paid paths cover the score route and one feed per provider", () => {
    const paths = paidPaths();
    assert.ok(paths.has("/score"));
    assert.ok(paths.has("/feed/compliant"));
    assert.ok(paths.has("/feed/stale"));
    assert.ok(paths.has("/feed/forger"));
    // Derived from the route table, so it cannot drift from what is paywalled.
    assert.equal(paths.size, Object.keys(buildRoutes()).length);
  });

  test("no free route is mistaken for a paid one", () => {
    const paths = paidPaths();
    for (const free of ["/providers", "/registry", "/claims", "/health", "/proof", "/"]) {
      assert.equal(paths.has(free), false, `${free} must stay cacheable and free`);
    }
  });
});
