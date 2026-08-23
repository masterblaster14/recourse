# Security posture

The published x402 security considerations, answered honestly. ✅ addressed ·
🟡 partly · ⬜ named and not built · ❌ deliberately out of scope.

Recourse is a **risk layer**, not a security product. But an agent-payments risk
layer that ignores the payment layer's own attack surface would be a strange
thing, so this walks the list item by item and says exactly where we stand.

---

## 1. Payment replay ✅ 🟡

*"If proofs are not single-use, an attacker may access a resource multiple times
with the same payment."*

**Settled payments** cannot be replayed: an x402 payment on Algorand is a real
asset transfer, and the chain rejects a duplicate transaction id. The facilitator
cannot settle the same group twice.

**Claims** have their own replay guard, and it is ours: `submit_claim` writes a
box keyed by the response's `request_id`, so one signed response pays out exactly
once, permanently. Verified adversarially in `npm run test:chain`.

**Bookkeeping** now enforces the same thing off chain — `payments.txid` carries a
unique index, so a repeated settlement id is rejected rather than silently
doubling the recorded volume.

🟡 What we do not do: expire a 402 challenge on a deadline of our own. The
facilitator's `maxTimeoutSeconds` bounds it, and we rely on that.

## 2. Payment interception (MitM) ✅

*"Strict HTTPS/TLS, HSTS, payload signing and integrity verification."*

This is the one Recourse was already built around.

- **Every response is signed.** `ed25519(request_id ‖ sha256(canonical_json(data)) ‖ uint64_be(data_timestamp))`,
  verified against a public key the provider committed **on chain**. Modified
  bytes in flight fail the hash check; a forged signature fails verification
  against the registered key. Interception is not merely unlikely, it is
  *detectable* — and if the tampering makes the response breach the SLA, it is
  claimable.
- **Canonical JSON**, verified byte-identical against a third party's published
  vectors, so integrity checking cannot drift between implementations.
- **HSTS**, `X-Content-Type-Options` and `Referrer-Policy` are set on every
  response; the deployment is HTTPS only.

Certificate pinning is not implemented — it is impractical for a service meant
to be called by arbitrary agents.

## 3. Facilitator centralisation ✅

*"Use multiple facilitators, or directly verify on-chain transactions."*

We use a single facilitator, as the challenge requires — but the agent **no
longer takes its word for anything**.

After every paid response, the agent independently confirms the reported
transaction id on chain: that it exists, that it is an asset transfer, that the
asset and amount are right, that it came *from* the agent and went *to* the
party the agent agreed to pay. A settlement the chain does not corroborate is
logged as a facilitator failure and never counted as a purchase
([`verifySettlement`](src/lib/chain.ts)).

That is the "directly verify on-chain transactions" mitigation, and it means a
compromised or buggy facilitator cannot convince this agent that money moved
when it did not, or that it went somewhere it did not.

## 4. Prompt injection ✅ 🟡

*"All 402 responses should undergo input validation before agents process them."*

Every 402 is validated before a payment payload is constructed
([`assertPaymentAcceptable`](src/lib/recourse-client.ts)): the advertised payee,
asset, network and price must match what the agent decided to buy. A 402 naming
a different recipient is refused, and no transaction is built.

This matters more than it sounds. Without it, an agent that carefully checks a
provider's collateral then pays whatever address the 402 happens to name is
trusting the endpoint rather than the registry — a compromised host could
collect real money under a bonded provider's reputation, and nothing would be
claimable, because the bonded provider never signed anything.

🟡 What we do not do is infer *intent* — see §8.

## 5. Overpayment and draining ✅

*"Hard spending limits, allow-lists for trusted payees, human-in-the-loop for
high-value transactions."* All three, and one more:

| Control | Stops |
|---|---|
| `maxPerPaymentMicro` | one hostile 402 demanding far above list price |
| `sessionBudgetMicro` | a run of individually-reasonable payments |
| `maxPaymentsPerMinute` | a runaway loop, bounded in time as well as money |
| `allowedHosts` | "pay `attacker.example`" — never reaches the network |
| `requireApprovalAboveMicro` | anything unusually large stops and asks a human |
| `haltAfterConsecutiveRefusals` | systematic wrongness; the agent stops for good |

Every one is checked against the agent's own ledger **before any network call**,
so a stop costs nothing and moves nothing. All are deterministic, so they hold
whether the agent was subverted by a prompt, a bug or a bad loop.

The session budget is the one that matters most: a per-payment cap alone is no
defence, because **a subverted agent does not need to overpay once — it only
needs to keep paying**.

## 6. Smart contract and on-chain risk ✅ 🟡

*"Audits and on-chain monitoring are critical."*

Not audited — this is a hackathon build and saying otherwise would be a lie. What
exists instead:

- **9 adversarial checks against the deployed contract** (`npm run test:chain`):
  forged signatures, moved timestamps, key rotation to void old evidence, SLA
  widening, withdrawal ahead of a claim, and claim replay. All rejected, plus one
  genuine claim upheld so a pass cannot come from a broken contract.
- **154 unit tests**, many asserting refusals rather than happy paths.
- **A critical bug found and fixed by review**: a bonded provider could rotate
  its signing key and void every pending claim for the price of one transaction.
  Documented in the README rather than quietly patched.
- **Continuous on-chain reads** — bonds, counters and claims are read from box
  storage on every request, not cached from a database.

🟡 **Claim front-running is real.** `submit_claim` pays `Txn.sender`, so whoever
submits a valid proof collects. In practice that is the payer, because only the
payer receives the signed response — but a leaked response can be claimed by
someone else. Making claims permissionless was the deliberate trade.

## 7. Privacy and linkability ❌

*"Single-use addresses can break up these chains."*

Not addressed, and there is a genuine tension worth naming rather than hiding:
**reputation requires linkability.** A provider's whole value here is that its
history, bond and claims attach to a stable identity. Rotating provider addresses
would destroy exactly the thing being measured.

The buyer side has no such constraint — an agent could rotate addresses between
sessions and lose nothing, since it is never the subject of a score. We have not
implemented it.

## 8. Intent inference ❌

Deciding whether an agent's *reasoning* was manipulated needs trace capture and a
risk model. That is a different product —
[x402-secure](https://github.com/t54-labs/x402-secure) does it well and composes
with this one.

We deliberately do not ship a stub of it. Every other claim in this project is
checkable from a terminal in under a minute; an endpoint that returned "looks
fine" with nothing behind it would be the first that is not.

---

# Part two — the five attacks

[*Five Attacks on x402 Agentic Payment Protocol*](https://arxiv.org/abs/2605.11781)
(Li, Wang & Wang — Ohio State / CSIRO / Manchester) is a formal analysis of the
protocol with a testbed and a live endpoint audit. Every attack in it was
checked against this codebase and its dependencies, and the findings below cite
the code rather than asserting a posture.

Four of the five are structurally closed, and **two of those are closed by
Algorand rather than by anything we wrote** — which is the most concrete answer
this project has to "why this chain".

## I‑A · Revert‑grant — not applicable ✅

*Resource granted before finality; a reorg then erases the payment.*

Two independent reasons this cannot happen here.

**Algorand has immediate finality.** A certified block cannot be reorganised, so
there is no probabilistic settlement to wait out and no `k` to tune. The paper's
measurements come from Base Sepolia, where reorgs are real. Adding the paper's
suggested confirmation-depth gate would be a no-op on this chain.

**The paywall does not grant optimistically anyway.** `@x402/hono` runs the
handler, captures the body, *withholds* it, settles, and replaces the body with
an error if settlement fails:

```js
const responseBody = Buffer.from(await res.clone().arrayBuffer());
c.res = void 0;                                     // response withheld
const settleResult = await httpServer.processSettlement(...);
if (!settleResult.success) {
  res = new Response(body, { status: response2.status });   // body replaced
}
```

## I‑B · Settlement preemption — closed by the scheme ✅

*An interceptor consumes the payment authorisation first; the payer is charged
and denied service.* The paper's mitigation **M2** is to bind settlement to the
facilitator the payer endorsed.

On AVM that binding is not optional. The payload is an **atomic transaction
group**, not a transferable authorisation:

| | Transaction | Signed by |
|---|---|---|
| `txn[0]` | fee payer, `amount: 0`, `fee: <entire group fee>` | **the facilitator** |
| `txn[1]` | the asset transfer, **`fee: 0`** | the agent |

The client signs only its own transaction — `clientIndexes` filters by
`txn.sender === this.signer.address`. So a stolen `X-PAYMENT` yields a
zero-fee transfer that is invalid alone, bound by a group ID that cannot be
re-formed, to a transaction requiring a key the interceptor does not have.

**Only the payer-endorsed facilitator can submit it.** M2, for free.

*(A note on a criticism that does not land: `access-control-expose-headers:
PAYMENT-RESPONSE, PAYMENT-REQUIRED` concerns server→client headers. The bearer
material is `X-PAYMENT`, which travels client→server. CORS exposure is
unrelated to it.)*

## II · Replay and resource binding — closed ✅ 🟡

*One payment, many grants.* The paper measured 248 grants from a single $0.001
payment and rated SDK idempotency **Critical**.

That result is for the EIP‑3009 shape, where the header is an authorisation a
server can settle repeatedly. Here `X-PAYMENT` carries a **signed Algorand
transaction**: replaying it means resubmitting the same txid, which the chain
rejects as a duplicate, so settlement fails and the body is replaced. Combined
with settle-before-release above, the door is shut twice.

**Resource binding (M3)** deserves a more careful answer. The facilitator checks

```js
if (amount   !== BigInt(requirements.amount)) → ErrAmountMismatch
if (receiver !== requirements.payTo)          → ErrReceiverMismatch
if (assetId  !== requirements.asset)          → ErrAssetMismatch
```

— but **no resource identifier travels in the transaction**. What actually
stops a payment quoted for `/score` being spent at `/feed` is that the two
demand different receivers.

🟡 That is a property of our address layout, not of the protocol, and it would
vanish the moment two routes shared a payee. So it is now asserted rather than
assumed: [`payeeCollisions()`](src/x402.ts) **throws at startup** if any two
paid routes name the same `payTo`, and
[`tests/x402-routes.test.ts`](tests/x402-routes.test.ts) pins the invariant.

## III · Cache leakage — was a real gap, now closed ✅

*Paid content stored by a shared cache and served to someone who never paid.*
The paper measured **100% leakage** through a stock nginx cache and found no SDK
adds protection automatically.

We had set **no cache header at all**. The `no-store` visible on a 402 came from
the SDK, and the paid `200` received `withPrivateCacheControl()`, which is:

```js
function withPrivateCacheControl(value) {
  if (!value) return "private";      // not "no-store"
  ...
}
```

`private` does stop a CDN holding paid content — the main vector — but it was
the SDK's choice rather than ours, it would disappear silently if that default
changed, and it still permits a browser or intermediate tool to keep a copy of
something somebody paid for.

Paid routes now carry **`Cache-Control: no-store, private`**, set by
[`src/index.ts`](src/index.ts) after the paywall's own post-handler code so it
is the last word. The path set is derived from the route table via
`paidPaths()`, so it cannot drift from what is actually paywalled, and free
routes stay cacheable. Verified against a real settled payment, not just a 402.

## IV · Server selection — this is the whole thesis ✅

*Metadata gaming and Sybil flooding steer agents to hostile endpoints — a single
crafted server captured 71.8% of agent traffic across 2,160 decisions, at
essentially zero cost.*

Mitigation **M6** — Sybil-resistant registration weighted by reputation — is
what Recourse *is*. Every identity must post real collateral, cheating burns it,
and the resulting score is machine-checkable before a payment exists. The
paper's "nearly free to run" is precisely the assumption a bond removes.

## Still open ❌

**Paid, and the provider silently sends nothing.** No signature means no proof
means nothing slashable. Preemption is closed, so provider silence is now the
only route into this hole — and it needs the challenge window (v2, specified in
the README including why it requires a claimant deposit).

## Scorecard

| Attack | Paper's mitigation | Recourse |
|---|---|:--|
| I‑A revert‑grant | M4 two‑phase / k‑confirmations | ✅ N/A — Algorand finality + settle‑before‑release |
| I‑B preemption | M2 facilitator‑bound settlement | ✅ enforced by the AVM group |
| II replay | M3 single‑use claims | ✅ txid uniqueness + settle‑before‑release |
| II resource binding | M3 resource‑bound claims | 🟡 distinct payees, now asserted at startup |
| III cache leakage | M5 cache hygiene | ✅ `no-store` on every paid route |
| IV server selection | M6 Sybil resistance | ✅ the thesis |
| paid‑but‑silent | — (open in the paper too) | ❌ needs the challenge window |

Deliberately **not** built: a confirmation-depth gate (meaningless on a chain
with immediate finality), a pre-serve idempotency ledger (the path is already
closed twice over — a third guard would be theatre), and a nonce in the signed
message (`request_id` is 32 random bytes already doing that job).

---

## Summary

| # | Consideration | Status |
|---|---|:--:|
| 1 | Payment replay | ✅ 🟡 |
| 2 | Interception / MitM | ✅ |
| 3 | Facilitator centralisation | ✅ |
| 4 | Prompt injection (402 validation) | ✅ |
| 5 | Overpayment and draining | ✅ |
| 6 | Contract and on-chain risk | ✅ 🟡 |
| 7 | Privacy and linkability | ❌ |
| 8 | Intent inference | ❌ |

Two are out of scope on purpose, and both are said plainly rather than fudged.
Nothing above is claimed without something in the repository that demonstrates
it.

Part two walks the five attacks from the published formal analysis: four
structurally closed, one gap found and fixed, one honestly open.
