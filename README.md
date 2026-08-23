# Recourse

**A risk layer for x402.** x402 lets an agent pay for an API call with no human
approving it — but it pays *first*, then receives the response. If that response
is stale or malformed, the money is gone and there is no recourse.

Recourse is the missing half. Providers stake a bond on Algorand and publish a
machine-readable SLA. Agents check reliability and bond coverage *before*
paying. When a provider signs a response that breaches its own published SLA,
the agent proves it on chain and compensation comes out of that provider's bond.

> x402 gives agents the ability to pay. Recourse gives them a reason to trust
> what they are paying for.

**Live:** <https://recourse-api-production.up.railway.app> ·
**App:** [`769688356`](https://lora.algokit.io/testnet/application/769688356) ·
**Network:** Algorand TestNet via the GoPlausible facilitator

---

## Verify it yourself in 60 seconds

Nothing here needs to be taken on trust. Every claim below is checkable from a
terminal.

**1. A real 402, with a real price, paid to a real address:**

```bash
curl -i https://recourse-api-production.up.railway.app/feed/compliant
```

Decode the `PAYMENT-REQUIRED` header and you get `scheme: exact`, the Algorand
TestNet CAIP-2 network, `1000` micro USDC (asset `10458941`), the provider's
`payTo` address, and GoPlausible's fee payer.

**2. Every transaction that proves this ran:**

```bash
curl https://recourse-api-production.up.railway.app/proof
```

**3. The bonds, read live from box storage on chain:**

```bash
curl https://recourse-api-production.up.railway.app/providers
```

**4. How much of the *live* x402 market has any collateral behind it:**

```bash
curl https://recourse-api-production.up.railway.app/ecosystem
```

**5. That the contract's guarantees actually hold** — nine adversarial checks
against the deployed app, including attempts to rotate the signing key, widen
the SLA, forge a timestamp and replay a claim:

```bash
npm install && npm run test:chain
```

---

## What the organisers said they would check

| Criterion | Where it is |
|---|---|
| x402 payment flow **live on Algorand TestNet** | [live API](https://recourse-api-production.up.railway.app/health) · 4 bonded providers, 5 paid routes |
| **An actual x402 transaction** viewable on Lora | proof table below — payment, bond, claim, all linked |
| Payment settles through the **GoPlausible facilitator** | [`src/x402.ts`](src/x402.ts) — `HTTPFacilitatorClient`, fee payer visible in every 402 |
| **`@x402` AVM dependencies** in `package.json` | `@x402/avm` `@x402/core` `@x402/hono` `@x402/fetch` `@x402-avm/extensions` |
| x402 **genuinely integrated**, not just mentioned | Remove x402 and this product has no reason to exist — see [How x402 is integrated](#how-x402-is-integrated) |
| **Machine to machine**, not human to machine | No human approves any payment — see [below](#this-is-machine-to-machine-by-construction) |
| Endpoint **indexed in the Bazaar catalog** | listed in the [public catalog](https://facilitator.goplausible.xyz/dashboard/leaderboards?cat=resources) — a route appears once a real payment against it settles |

Against the [x402 idea scorecard](https://x402-kit-kappa.vercel.app/scorecard): **12/12**,
with per-question reasoning in [Scorecard self-assessment](#scorecard-self-assessment).

---

## Live proof

| Item | Link |
|---|---|
| **Live API + dashboard** | [https://recourse-api-production.up.railway.app](https://recourse-api-production.up.railway.app) |
| Source | [github.com/masterblaster14/recourse](https://github.com/masterblaster14/recourse) |
| Recourse App ID (TestNet) | [`769688356`](https://lora.algokit.io/testnet/application/769688356) |
| App created | [`MNBW33DM…`](https://lora.algokit.io/testnet/transaction/MNBW33DMHWIRIQMSXWGSU362CPUZUJPQCRMDQRR4HSQRT2MVHHFQ) |
| App funded (box MBR + payouts) | [`5PYKDRPQ…`](https://lora.algokit.io/testnet/transaction/5PYKDRPQ7E2HWSBRDKABTJGYSVZLKI23EO65ZBJ72XNIHFKQ5DHQ) |
| App opted into USDC | [`I3B7IO74…`](https://lora.algokit.io/testnet/transaction/I3B7IO74MCTDAYV4KN44XHNCWLFBGLCTIQ4HFGXYUN4I3RLMKYKQ) |
| Acme Price Feed registered (SLA committed) | [`FJXMMJOI…`](https://lora.algokit.io/testnet/transaction/FJXMMJOI6UU67KSIK2F3GSMEXOUHGJPOYMFET3YFXE3DNPOHD3YQ) |
| Meridian Feed registered (SLA committed) | [`72ITJCR5…`](https://lora.algokit.io/testnet/transaction/72ITJCR54E3QOAPEPZYK6LDBQWUJXZTNLC26WFRD3FZUPVOZUNJQ) |
| Northwind Oracle registered (SLA committed) | [`APD3KOGP…`](https://lora.algokit.io/testnet/transaction/APD3KOGPB4HBTLDWL3NEGJEZHTPJCYO2BIJ2ERTPO5DNVIJBKAKQ) |
| Cerberus Data registered (SLA committed) | [`U6KJQTNB…`](https://lora.algokit.io/testnet/transaction/U6KJQTNBZBCUGV5OSOGMF3LPNBO2MWRRKOURBTKYDLGU4C5SPKAA) |
| Acme Price Feed bond staked | [`DPRBA3CU…`](https://lora.algokit.io/testnet/transaction/DPRBA3CUEVS6UQWRNRHEXZDJD7YJY73ERPDX37JBQCTTCOSUWRMQ) |
| Meridian Feed bond staked | [`DAJPQAJS…`](https://lora.algokit.io/testnet/transaction/DAJPQAJSWPJRBXNPQLU56MKGVFSYY6PC5776FKOWYUK4DKONU3FA) |
| Northwind Oracle bond staked | [`SMIPEXW7…`](https://lora.algokit.io/testnet/transaction/SMIPEXW7K3PYRR2HJXIXTNGX6BIIG5ILB72PH5Q4ZBNVRJKILEYA) |
| Cerberus Data bond staked | [`SOYLZPD3…`](https://lora.algokit.io/testnet/transaction/SOYLZPD3TWPOARWB2UXEERVOEXH4DJN5GJCN32LXXVZV5DNWPIBA) |
| **x402 payment settled** | [`T5WH7WNY…`](https://lora.algokit.io/testnet/transaction/T5WH7WNYREV33ZSYHNKLJ5QB5SJ37SWCDSGUJAP374KJ4ZL4OQQQ) |
| **Upheld claim (refund + slash)** | [`ULZQOKWD…`](https://lora.algokit.io/testnet/transaction/ULZQOKWD3NCD6JGJ5DEUDSLM3TOBH3NJ4SOBSOA6MC3BVPHYXYKQ) |
| Verified successes attested | [`YKYIVI5R…`](https://lora.algokit.io/testnet/transaction/YKYIVI5RYQGQVBU4RI4BQPXHBTDFNV4XBF3KKXEHBII3VGUTD7SQ) |
| Treasury (receives slashes) | [`ISOZHGXD…`](https://lora.algokit.io/testnet/account/ISOZHGXDZ3ZASAN6N2OJNUHI2KUQYQTS5HVZJICAP7IIG5KQLUHKIKJ4EI) |
| Payment asset | `10458941` (USDC) |
| Facilitator | [GoPlausible](https://facilitator.goplausible.xyz) |
| Network | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` (TestNet) |

`GET /proof` on the live API returns this table as JSON, recorded as each
transaction lands rather than transcribed by hand.
<!-- PROOF:END -->

---

---

## The problem

x402 is prepay and one-directional. The agent pays, *then* receives the response.
If that response is stale, empty or malformed, the money is gone and there is no
recourse.

One bad call does not matter. An agent making thousands of unattended calls an
hour does. The facilitator's receipt proves a payment settled — it says nothing
about whether the thing bought had any value.

So the only defence available today is *buy only from providers you already
trust*. That protects incumbents and shuts out every new provider, which kills
the open agent marketplace x402 exists to create.

## What Recourse does

1. A provider registers on chain, committing to a **price**, a **staleness
   bound**, a **latency bound**, the **sha256 of its published SLA**, and the
   **ed25519 key** it will sign responses with.
2. It stakes a **bond** in the same asset agents pay in.
3. Every response it serves is signed:
   `ed25519(request_id ‖ sha256(canonical_json(data)) ‖ uint64_be(data_timestamp))`
4. An agent buys `GET /score` before buying anything else, runs six checks on
   what it receives, and **routes accordingly**.
5. If a provider signed a response whose `data_timestamp` breaches the staleness
   bound *it published itself*, that signature is a self-incriminating proof. The
   agent submits it and the contract refunds the agent and slashes the provider —
   refund, slash and counter update as inner transactions in one atomic app call.

Nobody adjudicates. There is no oracle, no committee and no governance role. The
provider's own signature over its own published bound is the entire proof.

### Correctness note, stated up front

**Recourse does not reverse the original x402 payment.** That payment settled
through the facilitator and is final. Compensation is funded entirely by the
provider's bonded collateral. Atomicity applies to the recourse settlement only.

---

## This is machine-to-machine, by construction

x402 exists for agents paying agents, so it is worth being precise about who
pays whom here — no human approves any payment in this system.

**The payer is an autonomous process.** It holds its own Algorand keypair,
declares its own spend policy, and decides who to buy from with no human in the
loop. During a demo run it makes ~30 payment decisions in 208 seconds. Nobody
clicks anything per payment; the one button on the dashboard *starts the agent*,
and everything after that is the agent's own judgement.

**The buyer is a machine because only a machine has this problem.** A human
buying one API response looks at it and asks for a refund if it is junk. An
agent making thousands of unattended calls an hour cannot. The entire premise of
Recourse — that prepay plus no human review equals no recourse — only exists at
machine scale and machine speed.

**What it buys is machine-readable and machine-actionable.** `/score` returns a
risk record whose only consumer is a routing function. There is no page to read.
The agent parses it, compares bond coverage against price, and changes where its
money goes. When a provider breaches its SLA, the agent constructs and submits
the on-chain claim itself.

**The dashboard is an observer, not a checkout.** It holds no keys and cannot
pay for anything. It exists so a person can watch an agent transact, which is a
different thing from a person transacting.

### Scorecard self-assessment

Against the [x402 idea scorecard](https://x402-kit-kappa.vercel.app/scorecard):

| # | Question | Score | Why |
|---|---|:-:|---|
| 1 | Is the paying user clear? | **2** | An autonomous agent with its own keypair and declared spend controls. Its address is on the dashboard and every payment is on chain. |
| 2 | Is pay-per-request natural? | **2** | A risk lookup is per-decision and a price tick is per-call. Both are sub-cent, which is only viable because Algorand fees are sub-cent. |
| 3 | Does x402 improve the product? | **2** | Inverted: the product only exists because of x402. Prepay, unattended and irreversible is precisely the gap Recourse fills. |
| 4 | Demoable in 48 hours? | **2** | Already demoed. 26 paid calls, 10 on-chain claims, full routing switch, 208 seconds. |
| 5 | Real business model? | **2** | Two revenue lines, both already settling: a per-lookup fee on `/score`, and the slash penalty routed to the treasury (0.009 of every 0.01 claim). |
| 6 | Shows the full payment flow? | **2** | 402 → sign → facilitator verify and settle → 200, on TestNet through GoPlausible, with Lora links for every step. |

**12 / 12.**

---

## How x402 is integrated

x402 is load-bearing, not decorative — it is how every read in this system is
paid for, and the money genuinely goes to different recipients per route.

- **`@x402/hono`** — `paymentMiddleware` wraps three routes ([`src/x402.ts`](src/x402.ts)).
- **`@x402/avm`** — `ExactAvmScheme` on both server and client, the Algorand AVM
  payment mechanism.
- **`@x402/core`** — `HTTPFacilitatorClient` pointed at **GoPlausible**.
- **`@x402/fetch`** — the buying agent's client: `x402Client`, `wrapFetchWithPayment`,
  `toClientAvmSigner` ([`src/lib/recourse-client.ts`](src/lib/recourse-client.ts)).
- **`@x402-avm/extensions`** — Bazaar discovery metadata, so agents that have
  never heard of Recourse can find these endpoints in the public catalog.

The agent also declares **spend controls** (`setSpendControls`): an explicit
allow-list of assets and a hard per-payment ceiling of 5x the advertised price.
An unattended buyer should never hand a resource server an open cheque, and a
hostile 402 asking for 100x the list price is rejected by the client before any
transaction is built.

`payTo` differs per route: `/feed/compliant` pays **provider A**, `/feed/stale`
pays **provider B**, `/score` pays the treasury. That is what makes a refund out
of a specific provider's bond mean something.

Prices are declared as an explicit `AssetAmount` (`{ asset, amount }`) rather
than a `"$0.001"` string, so there is no ambiguity about which token was charged.

### Paid endpoints

| Endpoint | Price | Paid to | What it is |
|---|---|---|---|
| `GET /score?provider=<addr>` | 0.001 USDC | treasury | Full risk record: bond, coverage, SLA commitment hash, observed pass rates, on-chain dispute counters, reliability, confidence, recommendation |
| `GET /feed/compliant` | 0.001 USDC | provider A | Signed ALGO/USD feed. Honours its SLA. |
| `GET /feed/stale` | 0.001 USDC | provider B | Signed ALGO/USD feed. Signs a timestamp 45 min old against a 60 s bound — a provable breach on every call. |

Free: `/providers` `/sla` `/registry` `/ecosystem` `/preflight` `/claims` `/payments` `/proof` `/health` `/events` `/x402`

---

## What is on chain and what is not

**On chain** (app [`769675538`](https://lora.algokit.io/testnet/application/769675538)):
provider registry in box storage, bonds in custody, SLA hash + price + staleness
+ latency commitments, ed25519 signature verification, staleness proof, refund
and slash as inner transactions, replay guard keyed by `request_id`, success and
claim counters, ARC-28 events (`ProviderRegistered`, `BondDeposited`, `ClaimUpheld`).

**Off chain**: response sampling, score computation, the dashboard. These are
ordinary backend work and claiming otherwise would invite a fair question.

`record_success` is the one number that is an *attestation* rather than a proof —
the operator asserting it observed N good responses. It is deliberately kept
separate from `claim_count`, which is proven on chain. The score shows both.

---

## The demo

Both providers are bonded at 0.1 USDC and priced at 0.001 USDC per call. Both
publish `max_staleness_s: 60`. A bond of 0.1 covers exactly **10 upheld claims**
(refund 0.001 + slash 0.009 = 0.01 each).

Open the dashboard and press **Run live demo**:

1. Both providers look identical — bonded, active, **unmeasured**. The score says
   `low` confidence, not "100% reliable". A provider with one good call is not
   perfect, it is unmeasured, and a score that cannot say so is worse than none.
2. The agent **explores** both, because the *bond* — not a reputation neither has
   yet — is what protects it. This is the part that un-gates new providers.
3. Provider A's responses pass all six checks. Provider B's fail check 4
   (staleness) while passing check 6 (signature): a provable violation.
4. Each violation is claimed on chain. B's bond drains 0.01 at a time, live.
5. On call ~20, B's tenth claim empties the bond. The exhaustion branch fires,
   the contract marks it **inactive**, and the routing panel flips: B is
   excluded and every remaining call goes to A.

**Step 5 is the whole pitch**, so the routing decision is a first-class panel on
screen, not a line in a log.

```bash
npm run demo -- --calls 30      # same run, streamed to your terminal
```

---

## The security model, and where Recourse sits in it

Agent payments have several distinct threat surfaces. Recourse covers one of
them properly and names the others rather than gesturing at them.

| Threat | Layer | Covered here? |
|---|---|---|
| The agent goes rogue, or is prompt-injected into **spending too much** | agent-behaviour risk | **Yes, the deterministic half.** Session budget, rate limit, host allow-list, per-payment cap, self-halt — see below. |
| Judging **why** an agent misbehaved (was that reasoning chain manipulated?) | agent-behaviour risk | **No.** Needs trace capture and a model. [x402-secure](https://github.com/t54-labs/x402-secure) does this well and composes with us. |
| The facilitator fails, or a settlement never lands | payment rail | **No** — but a payment-layer failure is never charged to a provider's reliability, so an outage cannot tank every provider at once. |
| The seller takes payment and delivers junk | **counterparty risk** | **Yes.** Collateral, published SLA, proof, automatic payout. |
| The seller lies about freshness | counterparty risk | **Partly.** Detected by cross-provider consistency, scored, never slashed — it is evidence, not proof. |
| The seller withholds a response entirely | counterparty risk | **No.** No signature, no proof. Specified as v2 below. |
| **A compromised endpoint swaps the payee** | buyer-side control | **Yes.** See below. |
| A hostile 402 demands far more than the list price | buyer-side control | **Yes.** Spend controls, enforced client-side. |
| An interceptor **cashes the payment first**, so the buyer pays and is refused | protocol | **Closed by the scheme.** The AVM payload is an atomic group whose fee-paying half only the endorsed facilitator can sign. |
| One payment **replayed** for many responses | protocol | **Yes.** The chain rejects a duplicate txid, and the paywall settles before it releases the body. |
| Paid content **cached** and served to someone who never paid | protocol | **Yes.** `no-store` on every paid route, set by us rather than inherited. |
| Data released before payment is **final**, then reversed | protocol | **Not applicable.** Algorand blocks are final when certified; there is no reorg to wait out. |

All five attacks from the published formal analysis
([*Five Attacks on x402*](https://arxiv.org/abs/2605.11781)) are walked
line-by-line against this code in **[SECURITY.md](SECURITY.md)** — four
structurally closed, one gap found and fixed, one honestly open.

### The agent polices itself

A per-payment cap is not enough on its own. An agent that has been talked into
buying something does not need to overpay once — it only needs to **keep
paying**. So the agent carries a policy it checks against its own ledger before
any network call, meaning a stop costs nothing and moves nothing:

| Rule | Stops |
|---|---|
| `maxPerPaymentMicro` | one hostile 402 demanding far more than list price |
| `sessionBudgetMicro` | a run of individually-reasonable payments — the injection shape |
| `maxPaymentsPerMinute` | a runaway loop, bounded in time as well as money |
| `allowedHosts` | "pay `attacker.example`" — it is not on the list, so it never happens |
| `haltAfterConsecutiveRefusals` | systematic wrongness; the agent stops for good |

Every one is deterministic, so it holds whether the agent was subverted by a
prompt, a bug, or a bad loop — it never has to work out *why*. A breach halts
the agent rather than skipping one call, and the run ends saying which rule
fired.

**What this deliberately does not do** is judge intent. Deciding whether a
reasoning chain was manipulated needs trace capture and a risk model. That is a
different product, and pretending otherwise would put an unverifiable claim in a
project where every other claim is checkable from a terminal.

### Two more controls the agent enforces itself

**It refuses to pay anyone but the party whose collateral it checked.**
An agent that looks up a provider's bond and then pays whatever address the 402
happens to name is trusting the endpoint, not the registry. A compromised host
could swap in an attacker's address and collect real money under a bonded
provider's reputation — and nothing would be claimable afterwards, because the
bonded provider never signed anything. Before any transaction is constructed,
the agent checks the advertised `payTo`, asset, network and price against what
it decided to buy, and aborts if they disagree
([`assertPaymentAcceptable`](src/lib/recourse-client.ts)).

**It declares a spending limit and an asset allow-list.**
`setSpendControls` caps any single payment at 5x the advertised price and names
the only asset it will spend. A 402 asking for a hundred times the list price is
rejected client-side before a payment payload exists. An unattended buyer should
never hand a resource server an open cheque.

Both are covered by tests that assert the *refusal*, not just the happy path.

### What this deliberately does not claim

Recourse verifies **objective, published commitments** — that a signed response
breaches a bound the provider itself put on chain. It does not verify that data
is *correct*, and it never will without an external reference. "Trust what
you're paying for" means the seller has money at stake behind its promises, not
that a contract has checked the world.

## Known limits

- **Withheld signatures are not slashable.** An on-chain claim covers a response
  the provider *signed* that breaches its own published SLA. A provider that
  returns nothing, or refuses to sign, is marked down in the observed reliability
  score but cannot be slashed. Closing that gap needs a challenge window. That is
  v2 and it is not built here.
- **Schema and latency breaches are observed, not claimed.** Only the staleness
  breach is proven on chain, because it is the one the signature alone
  establishes. Schema breaches become claimable once the SLA hash commits to a
  schema.

  Latency deserves a specific note, because measuring it taught us something.
  An x402 resource server **settles the payment on chain before it returns the
  resource**, so ~4–6 s of Algorand finality sits *inside* the paid request and
  no client-side measurement can separate it from the provider's own work. The
  published `max_latency_ms` is therefore 8000 ms and describes the paid
  exchange, not the provider in isolation. That is exactly why a latency breach
  is scored but never slashed: it is not attributable. Our first cut used an
  800 ms bound, which failed every call — including the honest provider's — and
  the fix was to model the protocol correctly rather than to loosen a number
  until the demo looked good.
- **Compensation goes to whoever submits the proof.** `submit_claim` pays
  `Txn.sender`, not a recorded payer. In practice they are the same party
  because the signed response only goes to whoever paid for it, but a payer who
  leaks a response hands away the claim. Making claims permissionless was the
  deliberate trade: anyone can prove a violation, no privileged submitter needed.

- **Reputation is per address, so a Sybil reset is cheap.** A provider whose
  bond is drained can register a new address and start over. Punishment is
  bounded by the bond and nothing else. Binding an address to an operator needs
  an identity layer we have not built.

- **The bond is denominated in the payment asset.** On TestNet that is USDC.
  A bond denominated in a volatile asset would be a design problem, which is why
  the mainnet answer is a stablecoin — as here.
- **The demo price feed is simulated.** These endpoints exist to be measured
  against an SLA, not to be an oracle. Nothing in the mechanism depends on the
  numbers being real.
- **`record_success` is operator-attested**, as described above.

---

## The forger, and the honest limit of cryptographic proof

Staleness is measured against a timestamp the provider itself signs. So the
obvious attack is simply to lie about it: serve 45-minute-old data stamped
`now()`. That response passes **all six checks** — valid signature, matching
hash, timestamp inside the bound — and **cannot be slashed**. No cryptographic
test catches it, because in isolation a lie about time is indistinguishable
from the truth.

`/feed/forger` is exactly that provider, bonded and live alongside the others,
so the gap is demonstrated rather than described.

What catches it is that a lie about time is *not* indistinguishable across a
market. Every provider publishes `(claimed_timestamp, price)` pairs. A provider
honest about being stale — old price, old timestamp — sits on the same price
path as a fresh one; both are telling the truth about a different moment. The
forger claims *now* while carrying a value from 45 minutes ago, so it disagrees
with everyone else about a moment it named itself.

Two things about that check are deliberate:

- **No oracle.** The reference is the median of what providers collectively
  claim, one vote each. We never designate a source as truthful, and we never
  assert what the price "really" was. A minority forger stands out; that is all.
- **It requires three.** With two providers the median is their midpoint and
  each looks half-wrong — a tie, where picking a side is guessing. Three is the
  smallest set in which a majority can exist, which is why the demo runs two
  honest feeds and not one.

And the conclusion is a score, never a slash. Slashing on a statistic would be
precisely the centralised adjudication this project exists to remove.

## What is provable, what is observed, and what is neither

The most common way to overclaim in this space is to present every check as if
it carries the same weight. These do not, and the difference decides what can
touch collateral.

| Condition | Provable from signed bytes | Observed only | Needs an external reference |
|---|:--:|:--:|:--:|
| required fields present | ✅ | | |
| `response_hash` matches the delivered payload | ✅ | | |
| signature valid against the on-chain pubkey | ✅ | | |
| signed timestamp older than the published bound | ✅ | | |
| HTTP 200 / provider answered at all | | ✅ | |
| latency | | ✅ | |
| price agrees with the rest of the market | | ✅ | |
| the signed timestamp is *truthful* | | | ⚠️ |
| the data is *correct* | | | ⚠️ |

**Only the first block can be slashed.** Those four are checked inside the
contract, by the contract, from bytes the provider signed. Everything in the
second block feeds the reliability score and the routing decision, and never
touches the bond — a provider that fails them loses traffic, not collateral.
Nothing in the third block is claimed at all.

Latency deserves its place in the middle column specifically: an x402 server
settles payment on chain before returning the resource, so several seconds of
Algorand finality sit inside every measurement and no client can separate them
from the provider's own work. It is not attributable, so it is not slashable.

## The market this is for

`GET /ecosystem` reads the public GoPlausible Bazaar — every x402 endpoint an
agent could pay right now — and cross-references each recipient against the
Recourse registry on chain. At the time of writing:

```
300 endpoints indexed        2 backed by collateral        298 with no recourse

busiest, with nothing standing behind them:
  x402.twit.sh/tweets/search        75,389 settlements   $0.006
  onestepchess.xyz/api/v1/moves     25,755 settlements   $0.01
  api.syraa.fun/insights/*           8,071 settlements   $0.02
```

Seventy-five thousand payments to a single endpoint. If any one of those
responses was stale or malformed, the money was gone and there was nothing to
claim against. That is the gap this exists to close, and it is not hypothetical.

`GET /preflight?url=<any endpoint>` answers the question an agent should ask
before paying anyone:

```json
{
  "recourse_available": false,
  "verdict": "Live and payable, but the recipient has no collateral posted with
              Recourse. If this response is stale or malformed, the money is
              gone and there is nothing to claim against.",
  "entry": { "settle_count": 75389, "price": 0.006, "network_label": "Base" }
}
```

**What we deliberately do not do.** For endpoints we have never bought from we
report only observable facts — price, recipient, network, settlement count, and
whether collateral is posted. No reliability score, no rating. Claiming to
measure a stranger's uptime from a directory listing would undercut the entire
argument for measuring anything properly.

## How the score handles "not enough evidence"

A raw pass rate cannot distinguish 1/1 from 500/500 — both read as 1.0 — so a
naive score tells an agent that a provider with one lucky call is perfect. That
is worse than useless; it actively misleads the thing spending the money.

Recourse computes a **95% Wilson score interval** on the all-checks-passed rate
and acts on the **lower bound**, so the number an agent routes on is the worst
case the evidence supports rather than the flattering point estimate.
`confidence` is then a statement about how *narrow* that interval is, not an
arbitrary sample-count bucket.

| Evidence | Pass rate | 95% lower bound | Verdict |
|---|---|---|---|
| brand new | — | 0% | `unrated` |
| 1 clean call | 100% | 21% | `unrated` |
| 8 clean calls | 100% | 68% | `unrated` |
| 16 clean calls | 100% | 81% | `caution` |
| 50 clean calls | 100% | 93% | `caution` |
| 200 clean calls | 100% | 98% | `buy` |
| **any calls with an upheld claim** | — | 0% | `avoid` |

Two consequences worth calling out:

- **`unrated` is a distinct verdict from `avoid`.** Collapsing them would tell
  an agent that a brand-new honest provider is as bad as one caught cheating —
  exactly the incumbent-protecting behaviour Recourse exists to remove. An
  unrated provider stays eligible for routing, because its *bond* is what covers
  the risk while the evidence accumulates.
- **A proven violation short-circuits the evidence test.** One upheld claim is a
  fact, not a sample, so it produces `avoid` immediately regardless of how few
  calls have been made.

`buy` deliberately requires roughly 75 consecutive clean calls. The system does
not hand out its strongest verdict cheaply, and a score that did would not be
worth paying for.

## Two attacks this used to be open to

Both were found by reading the contract rather than by anything failing, and
both are closed and verified on chain by `npm run test:chain`.

**Rewriting the terms you are bonded against.** `register` used to let an
existing provider overwrite its `pubkey` and `max_staleness` while keeping its
bond. A provider could serve a batch of stale, signed responses and then rotate
its key for the price of one transaction: every outstanding signature would stop
verifying and every pending claim would become unfileable. Raising
`max_staleness` did the same thing more quietly. Terms are now frozen for as
long as collateral backs them — changing them requires unbonding first.

**Outrunning a claim with a withdrawal.** `withdraw_bond` used to be immediate.
Now `request_unbond` starts a cooldown and delists the provider at once, and the
bond stays claimable throughout. Closing this properly needed a second change
that is easy to miss: `submit_claim` used to require `active`, so a provider
could have delisted itself via `request_unbond` and become uncatchable during
its own cooldown. Claims now depend only on collateral being present.

## Adversarial checks

The happy path proves very little. `npm run verify:guards` buys real responses
and then attempts four claims against the deployed contract that **must** be
rejected, checking the rejection reason rather than accepting any failure:

| Attempt | Must be rejected because |
|---|---|
| Claim a fresh response as stale | `within SLA` — nothing was breached |
| Flip a byte in the signature | `bad signature` — the provider did not sign that |
| Move `data_timestamp` by one second | `bad signature` — the signature covers the timestamp |
| Replay an already-upheld claim | `already claimed` — one response pays out once |

It then files one genuine claim that **must** succeed, so a passing run also
proves the rejections are the guards working rather than the contract being
broken, and asserts the bond moved by exactly one claim's worth.

## The six checks

Run in order against the SLA the provider committed on chain
([`src/lib/recourse-client.ts`](src/lib/recourse-client.ts)):

1. HTTP status is 200
2. Every `required_field` is present
3. Measured latency is within `max_latency_ms`
4. `now - data_timestamp` is within `max_staleness_s`
5. `sha256(canonical_json(data))` equals `response_hash`
6. `ed25519_verify` passes against the pubkey committed on chain

Check 4 failing while check 6 passes is the claimable case: the provider signed
it, so it cannot disown it. Check 6 failing is *not* claimable — see Known limits.

The agent resolves the signing key the way an outsider would: it fetches `/sla`,
hashes the document, and compares against `sla_hash` from the chain. If they
disagree, the API is serving a different SLA than the one staked against, and
nothing it says can be trusted.

## Why bonds and not escrow

The intuitive fix for "I paid and got junk" is escrow: hold the buyer's money
until the response is judged good. It is the right primitive for a $5,000
milestone and the wrong one here, for four reasons.

**There is nowhere to put it in the protocol.** The x402 `exact` AVM scheme
submits a fixed group — the facilitator's fee-payer transaction plus an asset
transfer to `payTo`. There is no slot for an application call. Pointing `payTo`
at an escrow app means that app receives a bare asset transfer with no method
call and no idea which request it belongs to.

**The economics invert at this size.** Escrow needs on-chain state per call. A
box keyed by request id costs roughly `2500 + 400 x (34 + 48)` = **0.035 ALGO**
of minimum balance, locked until release, to protect a **0.001 USDC** payment —
about six times the value of the thing being protected, plus two extra app calls
in fees. A bond is `O(providers)`; escrow is `O(calls)`.

**It recovers but does not deter.** Escrow returns your money and costs the
cheat nothing beyond a sale it did not make. A 9x slash means breaching the SLA
on a 0.001 call costs 0.01 — cheating is strictly worse than not serving.

**It reintroduces the judgement problem.** Someone has to decide whether to
release. If the buyer decides, the buyer can take the data and never confirm. If
a timeout decides, the provider carries receivables risk on every call. If an
arbitrator decides, centralised trust is back.

> A bond *is* escrow, amortised. The provider locks collateral once and it
> covers thousands of calls: the same protection at a ten-thousandth of the
> on-chain footprint, plus a deterrent escrow cannot produce.

## Why 9x, and not some other number

The slash is `9 x price` on top of a full refund, so one breach costs `10 x` the
call's revenue. The rule is that **cheating must be worse than not serving at
all** — at 10x, no volume makes a bad response profitable, while an honest
provider with a near-zero failure rate pays essentially nothing to be bonded.

That asymmetry is the whole mechanism: the bond is cheap precisely for the
providers who deserve to be trusted, and ruinous for the ones who do not. It is
Spence signalling with the cost paid in collateral rather than education.

## Why a blockchain

The organisers said a blockchain is not required, so here is the honest answer:

> The bond has to sit somewhere neither the buyer nor the seller controls. The
> moment either side holds it, you have replaced a trust problem with a different
> trust problem. Everything else in Recourse could run on a server. That one
> thing cannot.

Supporting points, all specific to Algorand:

- **Sub-cent fees** mean disputing a 0.001 USDC call is economically sane. On
  most chains the dispute costs more than the purchase, so the mechanism is dead
  on arrival.
- **~3 s deterministic finality with no reorgs** keeps the claim path fast enough
  to run inside an agent's request loop.
- **Inner transactions inside an app call are atomic**, so refund, slash and
  counter update cannot partially execute.
- **Box storage** gives per-provider state that scales with the registry instead
  of fighting a fixed global schema.

---

## The one gap that is still open, and its exact v2

A provider that returns nothing, or returns something unsigned, cannot be
slashed. There is no artifact to check, so no proof exists. This is the last
real hole and it is not closable by cryptography — only by a game.

**The design.** An agent opens a dispute naming the provider and the
`request_id` it paid for. The provider has a fixed window to post a valid
signed response for that id. Silence slashes; a valid signature does not.

**Why this one needs a claimant deposit when the staleness path does not.** A
staleness claim is self-proving — the contract can check it from bytes the
provider signed, so filing a false one is impossible and a deposit would defend
nothing. Non-delivery is the opposite: the *absence* of evidence is the
allegation, and nothing stops an agent alleging it about a provider that
answered perfectly well. So the disputant stakes a deposit, forfeited to the
provider if a valid signed response appears.

That asymmetry is the whole point. Deposits are friction, and friction belongs
only where a claim cannot prove itself.

**Why it is not built here.** It needs a dispute lifecycle in the contract, a
second actor in the demo, and a window long enough to be meaningful but short
enough to watch. A half-built challenge window is worse than a specified one,
and this is a hackathon build with a stated scope.

**What would make it stronger still.** If the x402 signed offers and receipts
extension is available on AVM, the provider's signed offer at 402 time plus the
absence of a receipt turns "it never answered" into a much more legible claim.
Worth adopting before building the dispute lifecycle, not after.

## Run locally

```bash
npm install
npm run accounts          # generates 4 TestNet accounts into .env
```

Fund the four printed addresses with TestNet ALGO
([dispenser](https://lora.algokit.io/testnet/fund)), and the **deployer only**
with TestNet USDC ([Circle faucet](https://faucet.circle.com), choose Algorand
Testnet — under 1 USDC is enough; setup distributes the rest).

```bash
npm run contract:deploy   # deploys, funds and opts the app into the asset
npm run setup             # opt-ins, distribution, registration, bonds
npm run preflight         # tells you exactly what is still missing
npm start                 # http://localhost:3000
```

Run the tests:

```bash
npm test              # 110 unit tests, no network
npm run test:chain    # adversarial checks against the deployed contract
```

Rebuild the contract only if you edit it:

```bash
pip install puyapy algorand-python
npm run contract:build
```

Between rehearsals:

```bash
npm run topup                                                   # re-stake bonds, check box MBR headroom
curl -X POST -H "x-admin-key: $ADMIN_KEY" localhost:3000/admin/reset
```

Prove the contract's guards hold:

```bash
npm run verify:guards
```

---

## Repo layout

```
contracts/recourse/contract.py   Algorand Python: registry, bonds, claims
contracts/build/                 compiled TEAL + ARC-56 (committed)
src/x402.ts                      facilitator config, paid route definitions
src/lib/signing.ts               canonical JSON, sha256, ed25519 — one shared impl
src/lib/chain.ts                 algosdk client, ABI calls, box decoding
src/lib/recourse-client.ts       score / buy / verify / claim / select
src/lib/scoring.ts               reliability, confidence, recommendation
src/agent/runner.ts              the buying agent loop
src/routes/                      paid, public and admin routes
public/                          dashboard
```

## Further reading

| Document | What it covers |
|---|---|
| [SECURITY.md](SECURITY.md) | Every published x402 security consideration and all five attacks from the formal analysis, answered against this code |
| [FEATURES.md](FEATURES.md) | Complete register of what is built, what is partial, and what is deliberately excluded |
| [DEMO.md](DEMO.md) | Step-by-step walkthrough of the live demo |
| [DEPLOY.md](DEPLOY.md) | Deployment and operator runbook |

## Licence

MIT
