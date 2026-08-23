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
| ✅ | Settled-txid uniqueness | A repeated settlement id is rejected, not silently double-counted |
| ✅ | Transport hardening | HSTS, nosniff, no-referrer on every response |
| ✅ | **Paid-response cache isolation** | `no-store, private` on every paid route, set by us rather than inherited from the SDK — verified on a real settled 200, not just a 402 |
| ✅ | **Payee-collision guard** | Two paid routes sharing a `payTo` would make their payments interchangeable; `buildRoutes()` refuses to start |
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
| ✅ | **Human approval above a threshold** | Routine calls are autonomous; anything unusually large stops and asks |
| ✅ | **On-chain settlement verification** | Confirms the facilitator's reported txid really moved that asset, amount, sender and receiver |
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
| ✅ | **Cross-provider price consistency** | Catches a forger that passes every cryptographic check. Verified live: forger at 1.13% divergence against a 0.4% tolerance, both honest providers under 0.15% |
| ✅ | **Conclusive divergence is a verdict, not silence** | A measured forger reads `avoid`, never `unrated` — `unrated` is reserved for providers with too little evidence, and a caught one has plenty |
| ✅ | Evidence never slashes | Statistical findings cap the score; only proof takes collateral |
| ✅ | **Counterparty-weighted reputation** | Distinct payers, not raw volume. Self-payments excluded outright; confidence capped at `medium` while every observation traces to one payer |
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
| ✅ | **Live workflow panel** | All seven stages of one purchase filled in as they happen — refusals, settlement confirmation and slashing each shown where they occur, so the system can be explained by pointing at it |
| ✅ | One-button live demo | Starts the real agent making real payments |
| ✅ | Evidence ledger | `/proof`, backfilled from the database so a restart cannot erase it |
| ✅ | Terminal demo | Same story with no UI, as a fallback |
| ✅ | Operator tooling | `preflight`, `setup`, `topup`, `fund`, `sweep`, `readme` |
| ✅ | **End-to-end workflow documentation** | [WORKFLOW.md](WORKFLOW.md) — four traced flows with sequence diagrams, every step cited to the code that runs it |
| ✅ | **Provider CLI — bring your own endpoint** | `provider:init` / `provider:register` / `provider:test`. Self-service: no admin, no allow-list, no approval step |
| ✅ | **Self-registration verified end to end** | A fresh third-party wallet registered itself on TestNet with its own terms (0.002 price, 120s staleness) and staked its own bond — registry went 4 → 5 |
| ✅ | **Pre-flight slashability check** | `provider:test` buys one response as an agent would and reports PASS / FAIL / **SLASHABLE** before you take traffic |

## 7. Verification

| | Feature | Notes |
|:--:|---|---|
| ✅ | 146 unit tests | Signing, scoring, routing, box decoding, consistency, payee refusal, spend policy, resource binding, canonicalisation interop |
| ✅ | 9 on-chain guard checks | Adversarial, against the deployed contract |
| ✅ | Refusal-path testing | Tests assert what is *rejected*, not only what works |
| ✅ | **Published-attack audit** | All five attacks from the x402 formal analysis checked against this code — see [SECURITY.md](SECURITY.md) |
| ✅ | **Settlement-shape regression tests** | algod and indexer name the same fields differently; a crossed-over read failed silently. Both shapes pinned offline |
| ✅ | **Postgres BIGINT coercion tests** | `claimed_ts` arriving as a string made every sample unusable and left the forger detector inert in production while all tests passed against the in-memory store |
| ✅ | CI on push | GitHub Actions: typecheck + unit suite on every push and PR |

## 8. Attack surface — the published analyses

Walked item by item in [SECURITY.md](SECURITY.md), with code cited rather than
posture asserted.

| | Item | Notes |
|:--:|---|---|
| ✅ | Revert-grant (I‑A) | N/A — Algorand has immediate finality, and the paywall settles before releasing the body |
| ✅ | Settlement preemption (I‑B) | Closed by the AVM group: the agent's transfer is fee-0 and group-bound to a transaction only the facilitator can sign |
| ✅ | Replay (II) | Duplicate txid rejected by the chain, plus settle-before-release |
| 🟡 | Resource binding (II) | No resource travels in the transaction; distinct payees provide it, now asserted at startup instead of assumed |
| ✅ | Cache leakage (III) | Found as a real gap and fixed — `no-store` on paid routes |
| ✅ | Server selection (IV) | The thesis: Sybils cost collateral |
| ❌ | Paid-but-silent | The one open case; needs the challenge window |
| ❌ | Confirmation-depth gate | Deliberately not built — meaningless on a chain without reorgs |

---

## Known gaps, stated plainly

1. **Withheld responses are not slashable.** No signature, no proof. Needs the challenge window.
2. **Forged freshness is detected, not punished.** Slashing on a statistic would be the centralised adjudication this project exists to remove.
3. **The guarantee is capped at the live bond.** Insurance can be insolvent.
4. **Sybil reset is cheap.** Reputation is per address; a drained provider can start over.
5. **All four demo providers are ours.** The ecosystem view reframes it against ~296 real unbonded endpoints, but does not remove it. A fifth provider is registered by an unrelated wallet that self-enrolled through the CLI — it holds a real bond and publishes its own terms, which is why `/registry` reports five while the dashboard shows the four demo endpoints.
6. **Observed samples are only ours.** Now surfaced by the product rather than only admitted here: every provider reads `single source — confidence capped`, and no provider can reach `high` confidence until a second independent payer appears.
7. **Operational:** single region, no rate limiting, creator is a single hot key.
