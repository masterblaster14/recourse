# Feature register

Everything Recourse does today, what is deliberately excluded, and what is
specified but not built. Kept current as work lands.

**Legend:** ✅ built and verified · 🟡 built, partial by design · ⬜ specified, not built · ❌ deliberately out of scope

---

## 1. On-chain contract — app [`769688356`](https://lora.algokit.io/testnet/application/769688356)

Algorand Python (`algopy`), compiled to TEAL, deployed to TestNet.

| | Feature | Notes |
|:--:|---|---|
| ✅ | Provider registry in box storage | 129-byte fixed struct, decoded off chain without a simulate call |
| ✅ | Collateral custody | The app account holds the bonds; neither buyer nor seller can touch them |
| ✅ | On-chain SLA commitment | `pubkey`, `sla_hash`, `price`, `max_staleness`, `max_latency`, signed by the provider itself |
| ✅ | ed25519 signature verification **in TEAL** | `ed25519verify_bare`, 1900 opcode units against a 700 default — group-padded and `ensure_budget`'d |
| ✅ | Staleness proof from the chain's own clock | `Global.latest_timestamp − data_timestamp > max_staleness` |
| ✅ | Atomic settlement | Compensation, penalty and counters as inner transactions in one app call |
| ✅ | Replay guard | Box keyed by `request_id`; one response pays out once, ever |
| ✅ | Permissionless claims | No privileged caller, no "breach" flag — anyone can submit, the maths decides |
| ✅ | Terms frozen while bonded | Closes the key-rotation bypass that voided every pending claim |
| ✅ | Delayed unbonding | `request_unbond` delists at once; claims keep working through the cooldown |
| ✅ | Claim window + `prune_claim` | Bounds replay-guard state so minimum balance stops ratcheting |
| ✅ | `deregister` / `destroy` | Reclaims box and application minimum balance |
| ✅ | ARC-28 events | `ProviderRegistered`, `BondDeposited`, `ClaimUpheld` |
| 🟡 | `record_success` | An operator *attestation*, kept separate from proven `claim_count` |
| ⬜ | Non-delivery challenge window | Specified in the README, incl. why it needs a claimant deposit |
| ❌ | Payment escrow | Wrong primitive at 0.001 — see "Why bonds and not escrow" |
| ❌ | Governance / arbitration role | The provider's own signature is the only judge |

## 2. x402 integration

| | Feature | Notes |
|:--:|---|---|
| ✅ | Paid routes via `@x402/hono` | 5 paid routes, each with its own `payTo` |
| ✅ | AVM `exact` scheme | `@x402/avm` on both server and client |
| ✅ | GoPlausible facilitator | `HTTPFacilitatorClient`; fee payer visible in every 402 |
| ✅ | Explicit `AssetAmount` pricing | Asset id and atomic amount, not a `"$0.001"` string |
| ✅ | Bazaar discovery metadata | `@x402-avm/extensions`; routes appear in the public catalog after settlement |
| ✅ | Canonical resource URLs | Pinned, so TLS termination cannot publish `http://` to the catalog |
| ✅ | Server-side payment recording | Any buyer's settled payment is booked, not just our own agent's |
| ✅ | Canonical-JSON interop | Matches `payment-requirements-hash.v1` on all 6 published vectors |

## 3. The buying agent

| | Feature | Notes |
|:--:|---|---|
| ✅ | Autonomous purchasing | Own keypair, own limits; no human approves any individual payment |
| ✅ | Paid market survey | Buys `/score` for every candidate before spending on data |
| ✅ | Six-check verification | status, fields, latency, staleness, hash, signature |
| ✅ | SLA-hash chain of custody | Fetches the published SLA and checks it against the on-chain commitment before trusting the key inside |
| ✅ | Automatic claim filing | Constructs and submits the on-chain proof itself |
| ✅ | **Payee verification** | Refuses to pay anyone but the party whose collateral it checked |
| ✅ | **Spend controls** | Asset allow-list plus a hard per-payment cap, enforced client-side |
| ✅ | **Session budget** | Total spend cap — stops a run of individually-fine payments |
| ✅ | **Payment rate limit** | Bounds a runaway loop in time, not just in money |
| ✅ | **Host allow-list** | "pay attacker.example" never reaches the network |
| ✅ | **Self-halt** | A budget or host breach stops the agent for good, not just that call |
| ✅ | Bond-scaled exploration | A thin bond buys proportionally less rope |
| ✅ | Failure attribution | Payment-layer failures are discarded, never charged to a provider |
| ❌ | Reasoning-trace capture / intent inference | Needs a model and trace collection. The deterministic half of agent safety is built; judging *why* an agent misbehaved is a different product. |

## 4. Scoring and risk

| | Feature | Notes |
|:--:|---|---|
| ✅ | Wilson score interval | Acts on the 95% lower bound, not the flattering point estimate |
| ✅ | Kish effective sample size | Recency weighting and the interval share one denominator |
| ✅ | `unrated` as a distinct verdict | "Not enough evidence" is not the same as "bad" |
| ✅ | Proven claims short-circuit | One upheld claim is a fact, not a sample |
| ✅ | Bond coverage | `coverage_calls` — how many failures the collateral can actually pay for |
| ✅ | **Cross-provider price consistency** | Catches a forger that passes every cryptographic check |
| ✅ | Evidence never slashes | Statistical findings cap the score; only proof takes collateral |
| ⬜ | Counterparty-weighted reputation | Distinct payers, not raw success counts — hardens against self-dealing |
| ❌ | Data-correctness verification | Impossible without an external reference; scoped out explicitly |

## 5. The market view

| | Feature | Notes |
|:--:|---|---|
| ✅ | `/ecosystem` | Reads the public Bazaar and cross-references collateral on chain |
| ✅ | `/preflight?url=` | "If this endpoint lies to me, do I get anything back?" for any URL |
| ✅ | Facts only for strangers | No reliability score for endpoints never bought from |

## 6. Product surface

| | Feature | Notes |
|:--:|---|---|
| ✅ | Live dashboard | Routing panel, draining bonds, claim ledger, market view, SSE feed |
| ✅ | One-button live demo | Starts the real agent making real payments |
| ✅ | Evidence ledger | `/proof`, backfilled from the database so a restart cannot erase it |
| ✅ | Terminal demo | Same story with no UI, as a fallback |
| ✅ | Operator tooling | `preflight`, `setup`, `topup`, `fund`, `sweep`, `readme` |

## 7. Verification

| | Feature | Notes |
|:--:|---|---|
| ✅ | 100 unit tests | Signing, scoring, routing, box decoding, consistency, payee refusal, spend policy, canonicalisation interop |
| ✅ | 9 on-chain guard checks | Adversarial, against the deployed contract |
| ✅ | Refusal-path testing | Tests assert what is *rejected*, not only what works |
| ✅ | CI on push | GitHub Actions: typecheck + unit suite on every push and PR |

---

## Known gaps, stated plainly

1. **Withheld responses are not slashable.** No signature, no proof. Needs the challenge window.
2. **Forged freshness is detected, not punished.** Slashing on a statistic would be the centralised adjudication this project exists to remove.
3. **The guarantee is capped at the live bond.** Insurance can be insolvent.
4. **Sybil reset is cheap.** Reputation is per address; a drained provider can start over.
5. **All four demo providers are ours.** The ecosystem view reframes it against 298 real unbonded endpoints, but does not remove it.
6. **Observed samples are only ours** and unverifiable by third parties.
7. **Operational:** single region, no rate limiting, creator is a single hot key.
