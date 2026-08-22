# Recourse

**A risk layer for x402.** API providers stake a bond on Algorand and publish a
machine-readable SLA. Agents check reliability and bond coverage *before* paying.
When a provider signs a response that violates its own published SLA, the agent
files a claim and compensation is paid out of that provider's bond automatically.

> x402 gives agents the ability to pay. Recourse gives them a reason to trust
> what they are paying for.

<!-- PROOF:START -->
## Live proof

| Item | Link |
|---|---|
| Live API + dashboard | _pending deploy_ |
| Recourse App ID (TestNet) | [`769678323`](https://lora.algokit.io/testnet/application/769678323) |
| App created | [`MOU4VA5A…`](https://lora.algokit.io/testnet/transaction/MOU4VA5A66OQRG7H7EBO647DLYKBZ5QAU4WPW2G43FPMPIYG5VDQ) |
| App funded (box MBR + payouts) | [`66EHTWAT…`](https://lora.algokit.io/testnet/transaction/66EHTWATLYAHLKKQFKGLNYZ4XQL5B3PJVWBX5KGROKWZJZQGJBHQ) |
| App opted into USDC | [`HBEP2NFP…`](https://lora.algokit.io/testnet/transaction/HBEP2NFP4RPJMB337URZQPD3HOJP7RQ55JCGWNHBZNN7TFVZHK4A) |
| Acme Price Feed registered (SLA committed) | [`WEOSCGJC…`](https://lora.algokit.io/testnet/transaction/WEOSCGJC7JBICOOSRJIMQ2YXLRDFKSPSHDLNYHLR3UZ575RFQCBQ) |
| Northwind Oracle registered (SLA committed) | [`75ONEEMR…`](https://lora.algokit.io/testnet/transaction/75ONEEMRSFKR4LELCGV3J2XAPN66JIK46VACV33ONKVUZ26DAMEQ) |
| Acme Price Feed bond staked | [`XZCQRZQE…`](https://lora.algokit.io/testnet/transaction/XZCQRZQEHSZAWU4A77ETWXL2AKIQRO5ON6GMIZPRZXPN6QTVRNEA) |
| Northwind Oracle bond staked | [`P7MZGEXG…`](https://lora.algokit.io/testnet/transaction/P7MZGEXGUH2HM2QDU2I3HTKHEVVE35TN4DRYLHVCBEOW7MJ437OA) |
| **x402 payment settled** | [`UY4BZN7T…`](https://lora.algokit.io/testnet/transaction/UY4BZN7TZ2OIVFJW3HEJB5AWLLCOXGRDN5F5RXE7ASGKVHSIWV4Q) |
| **Upheld claim (refund + slash)** | [`NWHX25NH…`](https://lora.algokit.io/testnet/transaction/NWHX25NH64HYXQIGCG4U67NFWBEK2KP4CKRKMHWSQSP4CZQVTANA) |
| Verified successes attested | [`DMJX6DM5…`](https://lora.algokit.io/testnet/transaction/DMJX6DM54SHAMUBNIWJPQL3N3CV6JJTA6Y5JCVBRMA2HYOAQYBSA) |
| Treasury (receives slashes) | [`ISOZHGXD…`](https://lora.algokit.io/testnet/account/ISOZHGXDZ3ZASAN6N2OJNUHI2KUQYQTS5HVZJICAP7IIG5KQLUHKIKJ4EI) |
| Payment asset | `10458941` (USDC) |
| Facilitator | [GoPlausible](https://facilitator.goplausible.xyz) |
| Network | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` (TestNet) |

`GET /proof` on the live API returns this table as JSON, recorded as each
transaction lands rather than transcribed by hand.
<!-- PROOF:END -->

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

Free: `/providers` `/sla` `/registry` `/claims` `/payments` `/proof` `/health` `/events` `/x402`

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
- **A provider can withdraw its bond before a claim lands.** `withdraw_bond` is
  immediate, so a provider that knows it just served a bad response could race
  the claim and unstake first. The honest fix is a withdrawal timelock — an
  unstake request that only settles after a delay longer than the claim window —
  and it is a contract change we chose not to half-build tonight. Note the
  attack is self-limiting in one respect: unstaking drops `coverage_calls` to
  zero, and the routing policy excludes an unbonded provider immediately, so the
  provider escapes one slash by ending its own access to the market.

- **Compensation goes to whoever submits the proof.** `submit_claim` pays
  `Txn.sender`, not a recorded payer. In practice they are the same party
  because the signed response is only returned to whoever paid for it, but a
  payer who leaks a response hands away the claim. Making claims permissionless
  was the deliberate trade: anyone can prove a violation, and no privileged
  submitter is needed.

- **The bond is denominated in the payment asset.** On TestNet that is USDC.
  A bond denominated in a volatile asset would be a design problem, which is why
  the mainnet answer is a stablecoin — as here.
- **The demo price feed is simulated.** These endpoints exist to be measured
  against an SLA, not to be an oracle. Nothing in the mechanism depends on the
  numbers being real.
- **`record_success` is operator-attested**, as described above.

---

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

## Licence

MIT
