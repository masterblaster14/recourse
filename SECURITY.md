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
- **102 unit tests**, many asserting refusals rather than happy paths.
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
