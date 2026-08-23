# Recourse

**A security and risk layer for x402.**

x402 lets a software agent pay for an API call without a human approving it. The
catch is the order of events: the agent pays first, and gets the response
second. If that response turns out to be stale or malformed, the money is
already gone and the buyer has no way to recover it.

Recourse fixes that. Sellers stake collateral on Algorand and publish a
machine-readable SLA. Buyers check what is backing a seller before paying. When
a seller signs a response that breaks its own published promise, the buyer
proves it on chain and the contract pays compensation out of that seller's
collateral. There is no arbitrator, no dispute process, and no company deciding
who is right.

Live: <https://recourse-api-production.up.railway.app>

App on Algorand TestNet: [769688356](https://lora.algokit.io/testnet/application/769688356)

Payments settle through the [GoPlausible](https://facilitator.goplausible.xyz) facilitator.

---

## Contents

1. [The problem](#the-problem)
2. [How it works](#how-it-works)
3. [Where x402 is used](#where-x402-is-used)
4. [Proof on chain](#proof-on-chain)
5. [Try it in two minutes, no setup needed](#try-it-in-two-minutes-no-setup-needed)
6. [Run the whole thing yourself](#run-the-whole-thing-yourself)
7. [Register your own endpoint](#register-your-own-endpoint)
8. [Security](#security)
9. [Everything that is built](#everything-that-is-built)
10. [What this does not do](#what-this-does-not-do)

---

## The problem

x402 is prepaid and one directional. The agent pays, then gets the response. If
that response is stale, empty, or malformed, the money is spent and there is no
way to get it back.

One bad call does not matter. An agent making thousands of unattended calls an
hour does. The facilitator gives you a receipt proving a payment settled, but a
receipt says nothing about whether the thing you bought had any value.

So the only defence available today is to buy only from sellers you already
trust. That protects incumbents and locks out every new seller, which is the
opposite of the open agent marketplace x402 exists to create.

## How it works

Four steps.

**1. A seller registers on chain.** It commits to a price, a maximum staleness,
a maximum latency, the sha256 of its published SLA document, and the ed25519
public key it will sign every response with. Registration is permissionless.
`register` and `deposit_bond` both key off the transaction sender, so a seller
enrols itself and there is no operator who could approve or refuse anyone.

**2. It stakes collateral** in the same asset that buyers pay in.

**3. Every response it serves is signed:**

```
ed25519( request_id || sha256(canonical_json(data)) || uint64_be(data_timestamp) )
```

The signature covers the content and the timestamp together. A seller cannot
later claim it never said the data was fresh.

**4. A buyer checks, buys, then verifies.** It buys a reliability record before
spending anything on data, runs six checks on what comes back, and routes
accordingly. If a seller signed a response whose timestamp breaks the staleness
bound it published itself, that signature is a self-incriminating proof. The
buyer submits it, and the contract refunds the buyer and slashes the seller in
one atomic application call.

The property that matters: **the seller's own signature is what convicts it, and
the blockchain's own clock is the witness.** Nobody arbitrates.

## Where x402 is used

x402 is not decoration here. Remove it and the product has no reason to exist.

| Where | What happens |
|---|---|
| Five paid routes | `GET /score` plus four price feeds, each behind `@x402/hono` |
| Scheme | `exact` on the AVM, using `@x402/avm` on both server and client |
| Facilitator | GoPlausible, through `HTTPFacilitatorClient`. Its fee payer appears in every 402 challenge |
| Pricing | Declared as an explicit asset id and atomic amount, not a dollar string |
| Discovery | Routes are published to the public GoPlausible Bazaar catalogue through `@x402-avm/extensions` |
| The buying agent | Uses `@x402/fetch` with its own wallet and its own spending limits |

The part worth noticing: **the risk data itself is sold over x402.** Before the
agent spends money on a price feed, it buys a reliability record for each
candidate seller, and it pays for those with the same protocol. Risk assessment
is a paid machine to machine service, not a free lookup.

Dependencies in `package.json`: `@x402/avm`, `@x402/core`, `@x402/hono`,
`@x402/fetch`, `@x402-avm/extensions`.

### The paid routes

| Route | Price | Paid to | Behaviour |
|---|---|---|---|
| `GET /score?provider=<addr>` | 0.001 USDC | treasury | Reliability, collateral coverage, published SLA |
| `GET /feed/compliant` | 0.001 USDC | Acme | Fresh data, honest timestamp |
| `GET /feed/compliant-2` | 0.001 USDC | Meridian | Fresh data, honest timestamp |
| `GET /feed/stale` | 0.001 USDC | Northwind | 45 minute old data, honest timestamp. Provably in breach |
| `GET /feed/forger` | 0.001 USDC | Cerberus | The same old data, timestamp forged to now |

Each route pays a different address. That is load bearing rather than
decorative: a refund out of a specific seller's collateral only means something
if the money actually went to that seller in the first place.

## Proof on chain

Every one of these is a real transaction on Algorand TestNet. Open any of them.

| What | Transaction |
|---|---|
| Recourse app | [769688356](https://lora.algokit.io/testnet/application/769688356) |
| App created | [MNBW33DM...](https://lora.algokit.io/testnet/transaction/MNBW33DMHWIRIQMSXWGSU362CPUZUJPQCRMDQRR4HSQRT2MVHHFQ) |
| App funded for box storage | [5PYKDRPQ...](https://lora.algokit.io/testnet/transaction/5PYKDRPQ7E2HWSBRDKABTJGYSVZLKI23EO65ZBJ72XNIHFKQ5DHQ) |
| App opted into USDC | [I3B7IO74...](https://lora.algokit.io/testnet/transaction/I3B7IO74MCTDAYV4KN44XHNCWLFBGLCTIQ4HFGXYUN4I3RLMKYKQ) |
| Acme registered, SLA committed | [FJXMMJOI...](https://lora.algokit.io/testnet/transaction/FJXMMJOI6UU67KSIK2F3GSMEXOUHGJPOYMFET3YFXE3DNPOHD3YQ) |
| Meridian registered | [72ITJCR5...](https://lora.algokit.io/testnet/transaction/72ITJCR54E3QOAPEPZYK6LDBQWUJXZTNLC26WFRD3FZUPVOZUNJQ) |
| Northwind registered | [APD3KOGP...](https://lora.algokit.io/testnet/transaction/APD3KOGPB4HBTLDWL3NEGJEZHTPJCYO2BIJ2ERTPO5DNVIJBKAKQ) |
| Cerberus registered | [U6KJQTNB...](https://lora.algokit.io/testnet/transaction/U6KJQTNBZBCUGV5OSOGMF3LPNBO2MWRRKOURBTKYDLGU4C5SPKAA) |
| Acme collateral staked | [DPRBA3CU...](https://lora.algokit.io/testnet/transaction/DPRBA3CUEVS6UQWRNRHEXZDJD7YJY73ERPDX37JBQCTTCOSUWRMQ) |
| Meridian collateral staked | [DAJPQAJS...](https://lora.algokit.io/testnet/transaction/DAJPQAJSWPJRBXNPQLU56MKGVFSYY6PC5776FKOWYUK4DKONU3FA) |
| Northwind collateral staked | [SMIPEXW7...](https://lora.algokit.io/testnet/transaction/SMIPEXW7K3PYRR2HJXIXTNGX6BIIG5ILB72PH5Q4ZBNVRJKILEYA) |
| Cerberus collateral staked | [SOYLZPD3...](https://lora.algokit.io/testnet/transaction/SOYLZPD3TWPOARWB2UXEERVOEXH4DJN5GJCN32LXXVZV5DNWPIBA) |
| **An x402 payment settling** | [T5WH7WNY...](https://lora.algokit.io/testnet/transaction/T5WH7WNYREV33ZSYHNKLJ5QB5SJ37SWCDSGUJAP374KJ4ZL4OQQQ) |
| **A claim upheld: refund plus slash** | [ULZQOKWD...](https://lora.algokit.io/testnet/transaction/ULZQOKWD3NCD6JGJ5DEUDSLM3TOBH3NJ4SOBSOA6MC3BVPHYXYKQ) |
| Verified good responses attested | [YKYIVI5R...](https://lora.algokit.io/testnet/transaction/YKYIVI5RYQGQVBU4RI4BQPXHBTDFNV4XBF3KKXEHBII3VGUTD7SQ) |
| Treasury, receives penalties | [ISOZHGXD...](https://lora.algokit.io/testnet/account/ISOZHGXDZ3ZASAN6N2OJNUHI2KUQYQTS5HVZJICAP7IIG5KQLUHKIKJ4EI) |

Payment asset is `10458941`, which is USDC on TestNet. The network is
`algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=`.

`GET /proof` on the live API returns this table as JSON. It is written as each
transaction lands, not typed in by hand.

## Try it in two minutes, no setup needed

You do not need to install anything or own a wallet for any of this. Each
command works from a terminal on any machine.

**See a real 402 payment challenge:**

```bash
curl -i https://recourse-api-production.up.railway.app/feed/compliant
```

You get back HTTP 402 and a `PAYMENT-REQUIRED` header. Decode it and you will
see the scheme, the network, the price in atomic units, the address to pay, and
GoPlausible's fee payer.

**See the collateral, read live from the blockchain:**

```bash
curl https://recourse-api-production.up.railway.app/providers
```

**See how much of the real x402 market has anything backing it:**

```bash
curl https://recourse-api-production.up.railway.app/ecosystem
```

At the time of writing that returns 300 endpoints indexed, 4 with collateral
behind them, and 296 with none.

**Check any endpoint on the internet, not just ours:**

```bash
curl "https://recourse-api-production.up.railway.app/preflight?url=https://example.com/api"
```

**Watch it happen.** Open the dashboard and you will see the four sellers, their
collateral, and a live activity feed. Triggering a run needs an admin key, so to
drive it yourself, follow the setup below and run your own copy.

## Run the whole thing yourself

This section assumes you have never touched Algorand before. Everything runs on
TestNet, so none of it costs real money.

### What you need

- **Node.js 20 or newer.** Check with `node --version`. If you do not have it,
  install from <https://nodejs.org>.
- **Nothing else.** The smart contract is already compiled and committed, so you
  do not need Python, AlgoKit, or any compiler.

### Step 1: get the code

```bash
git clone https://github.com/masterblaster14/recourse.git
cd recourse
npm install
```

### Step 2: run the tests

This needs no network, no wallet, and no configuration. It is the fastest way to
confirm the checkout works.

```bash
npm test
```

You should see 158 tests pass.

### Step 3: create wallets

```bash
npm run accounts
```

This writes a `.env` file containing six freshly generated TestNet accounts: a
deployer, four sellers, and the buying agent. It refuses to overwrite an
existing `.env`, so you cannot lose keys by running it twice.

These are throwaway TestNet keys. Never put a real wallet's mnemonic in this
file. `.env` is gitignored.

### Step 4: get free TestNet ALGO

Open <https://bank.testnet.algorand.network>, paste in each address from your
`.env`, and click dispense. You need roughly 1 ALGO per account.

The addresses to fund are `DEPLOYER_ADDRESS`, `PROVIDER_A_ADDRESS` through
`PROVIDER_D_ADDRESS`, and `AGENT_ADDRESS`.

### Step 5: get a test payment asset

The demo uses TestNet USDC, asset id `10458941`. If you cannot get any, mint
your own test asset instead:

```bash
npm run asset:mint
```

That creates a new asset and prints the id to put in `PAYMENT_ASSET_ID`.

### Step 6: deploy the contract

```bash
npm run contract:deploy
```

This deploys the Recourse application to TestNet and writes the resulting app id
into your `.env` as `RECOURSE_APP_ID`. It prints a link to the app on Lora, the
Algorand block explorer.

### Step 7: set everything up

```bash
npm run setup
```

This opts every account into the payment asset, distributes the asset from the
deployer, registers all four sellers on chain with their SLA commitments, and
stakes their collateral. It is safe to run repeatedly, and it tells you exactly
what is still missing if a step cannot complete.

### Step 8: check you are ready

```bash
npm run preflight
```

This checks balances, registrations, collateral, and the facilitator connection,
then tells you what to fix if anything is wrong.

### Step 9: start the server

```bash
npm start
```

Open <http://localhost:3000>. The dashboard shows your four sellers, read live
from the blockchain.

### Step 10: run the agent

Either press **Start the agent** on the dashboard, using the `ADMIN_KEY` value
from your `.env`, or run it from the terminal:

```bash
npm run demo -- --calls 26
```

You will watch the agent buy reliability data, choose a seller, pay over x402,
verify the response, catch the stale seller, and file a claim that takes money
out of that seller's collateral. Every transaction is printed with a link.

### Step 11: prove the contract's guarantees hold

```bash
npm run test:chain
```

This runs nine adversarial checks against your deployed contract. It tries to
forge a signature, move a timestamp, rotate a signing key to void old evidence,
widen an SLA after the fact, withdraw collateral ahead of a pending claim, and
replay a claim. All of them are rejected. It also files one genuine claim, so a
pass cannot come from a contract that simply rejects everything.

### If something goes wrong

| Problem | Fix |
|---|---|
| `RECOURSE_APP_ID is not set` | Run step 6 |
| `insufficient balance` | Top up from the faucet in step 4 |
| Claims fail with a minimum balance error | The app account needs ALGO for claim storage. Send it 1 ALGO |
| A seller's collateral is drained | `npm run topup -- --amount 0.2` |
| The demo shows no violations | Call `POST /admin/reset` first. Past evidence makes the agent correctly refuse to buy from sellers it has already caught |

## Register your own endpoint

The registry has no admin. Anyone can join, and the four demo sellers have no
special status.

**1. Generate a signing key and your SLA document.** Nothing touches the chain
in this step.

```bash
npm run provider:init -- --address YOUR_ALGO_ADDRESS --price 0.002 --staleness 120
```

Keep the printed secret key private. Publish the printed JSON document, exactly
as printed, at a URL agents can fetch.

**2. Register and stake collateral.**

```bash
npm run provider:register -- --sla-url https://you.example/sla --bond 0.2 --mnemonic "your twenty five words"
```

This fetches what you published, refuses if the document names a different
wallet, commits the hash on chain, stakes your collateral, then reads it back
from the chain rather than trusting its own success message.

**3. Find out whether your endpoint would survive its own SLA.**

```bash
npm run provider:test -- --endpoint https://you.example/feed --provider YOUR_ADDRESS --sla-url https://you.example/sla
```

It buys one response exactly as an agent would, with a real payment, runs the
six checks, and tells you one of three things:

```
PASS       this response honoured everything you committed to
FAIL       an agent would route away from you, but nothing is claimable
SLASHABLE  you signed a response that breaks your own SLA, and anyone
           holding it can take 0.01 USDC from your collateral
```

Registering is a promise. The collateral is what makes the promise expensive.
Finding out that your endpoint breaches its own SLA before you take traffic is
the cheapest this discovery will ever be.

### Buying from your own agent

The client takes its own wallet and its own limits. Nothing is tied to ours.

```ts
import { RecourseClient } from "recourse/src/lib/recourse-client.ts";

const agent = new RecourseClient(myMnemonic, {
  maxPerPaymentMicro: 2000,
  sessionBudgetMicro: 100_000,
  maxPaymentsPerMinute: 30,
  allowedHosts: ["api.mysupplier.com"],
  requireApprovalAboveMicro: 25_000,
  haltAfterConsecutiveRefusals: 3,
});

const { record } = await agent.score(RECOURSE_URL, sellerAddress);
if (record && record.recommendation !== "avoid") {
  const result = await agent.buy(endpoint, { payTo: sellerAddress });
  const outcome = agent.verify(result, record.sla, pubkey);
  if (outcome.provableViolation) await agent.claim({ /* ... */ });
}
```

Every instance carries its own keypair, spending policy and private ledger, so
two agents running in one process cannot spend each other's budget.

## Security

Full detail is in [SECURITY.md](SECURITY.md), which walks every published x402
security consideration and every attack from the formal analysis paper, and says
plainly where the answer is no.

### The eight published considerations

| Consideration | Status |
|---|---|
| Payment replay | Settled payments cannot replay, because the chain rejects duplicate transaction ids. Claims have their own on chain replay guard keyed by request id, so one signed response pays out exactly once, permanently |
| Interception and tampering | Every response is signed and verified against a key committed on chain. Modified bytes fail the hash check. HSTS, nosniff and no-referrer are set on every response |
| Facilitator centralisation | The agent independently confirms every reported transaction on chain: that it exists, that it is an asset transfer, and that it moved the right asset and amount from us to the party we agreed to pay |
| Prompt injection through 402 responses | Every challenge is validated before a payment payload is built. A 402 naming a different recipient is refused, and no transaction is created |
| Overpayment and draining | Six controls, all checked against the agent's own ledger before any network call: per payment cap, session budget, rate limit, host allow list, human approval above a threshold, and self halt after repeated refusals |
| Contract and on chain risk | Nine adversarial checks against the deployed contract, plus 158 unit tests. Not audited, and we do not claim otherwise |
| Privacy and linkability | Not addressed. Reputation requires linkability, so rotating seller addresses would destroy the thing being measured |
| Intent inference | Out of scope. Judging whether an agent's reasoning was manipulated needs trace capture and a model |

### The five attacks from the published analysis

Checked against this codebase and its dependencies, not asserted.

| Attack | Where we stand |
|---|---|
| Revert grant, where data is released before the payment is final | Not applicable. Algorand blocks are final when certified, so there is no reorg to wait out. Separately, the paywall settles before it releases the response body |
| Settlement preemption, where an interceptor cashes the payment first | Closed by the scheme. The AVM payload is an atomic group whose fee paying half only the endorsed facilitator can sign, and the buyer's transfer carries zero fee so it is invalid on its own |
| Replay, where one payment buys many responses | Closed twice over. Replaying means resubmitting the same transaction id, which the chain rejects, and the paywall settles before releasing the body |
| Cache leakage, where paid content is served to someone who never paid | This was a real gap here, now fixed. Paid routes carry `Cache-Control: no-store, private`, set by us rather than inherited from the SDK |
| Server selection, where metadata gaming steers agents to hostile endpoints | This is the whole thesis. Sybil identities cost real collateral, and cheating burns it |

### Things found and fixed while building this

Listed because a record of what went right is not very informative.

- A seller could rotate its signing key and void every pending claim for the
  price of one transaction. Registration now freezes terms while collateral is
  posted.
- Settlement verification read the indexer's field names against an algod
  response, so it silently rejected every freshly settled payment while
  appearing to work.
- The cross provider consistency detector had never run in production. A
  Postgres BIGINT arrives as a string, and the filter required a number, so
  every sample was discarded without any error being raised.
- That detector's tolerance had been calibrated against a synthetic price series
  so calm it barely moved. Given realistic volatility it produced a 58 percent
  false positive rate, and a live run wrongly flagged an honest seller.
- Claims were silently failing because each one writes a storage box that raises
  the application's minimum balance, and the account had run out of headroom.

## Everything that is built

The complete register, including what is deliberately excluded, is in
[FEATURES.md](FEATURES.md). The short version:

**On chain**, in Algorand Python compiled to TEAL: a seller registry in box
storage, custody of collateral, ed25519 signature verification inside the
contract, staleness proved against the chain's own clock, atomic settlement of
refund and penalty as inner transactions, a permanent replay guard, delayed
unbonding so a seller cannot pull collateral ahead of a claim, and terms frozen
while bonded.

**In the agent**: autonomous purchasing with its own wallet, a paid market
survey before spending on data, six verification checks, chain of custody on the
signing key, automatic claim filing, payee verification, six spending controls,
and independent on chain confirmation of every settlement.

**In the scoring**: a Wilson confidence interval acting on the lower bound
rather than the flattering point estimate, Kish effective sample size, `unrated`
kept distinct from `avoid`, cross provider price consistency, counterparty
weighted confidence, and a monitoring floor so the agent never stops watching
the rest of the market.

**On the surface**: a live dashboard showing every stage of each purchase as it
happens, a one button demo that makes real payments, an evidence ledger, a view
of the real x402 market, and a provider CLI for joining the registry.

## What this does not do

Every one of these is a real limit, and each is documented rather than hidden.

**A seller that returns nothing at all cannot be slashed.** No signature means
no proof. This is the one hole still open. Closing it needs a challenge window
where the seller must produce a signed response by a deadline, and where the
challenger posts a deposit so the mechanism cannot be used to harass honest
sellers. It is specified and not built.

**Forged freshness is detected, not punished.** A seller that serves old data
stamped with the current time passes every cryptographic check. It is caught by
disagreeing with the rest of the market about what the price was at the moment
it named, and that finding caps its score and costs it traffic, but never takes
its collateral. Slashing on a statistical inference would be exactly the
centralised judgement this project exists to remove.

**Detection depends on the price having moved.** If the market sat still for
forty five minutes, then forty five minute old data is the same number as fresh
data. Undetectable, and also harmless.

**The guarantee is capped at the live collateral.** Insurance can be insolvent.

**Identity is cheap.** Reputation attaches to an address, so a drained seller
can start again with a new one. What it cannot do is start again with a
reputation.

**Latency is measured but never slashed.** x402 settles on chain before the
response returns, so several seconds of blockchain time sit inside every
measurement. That makes it unattributable to the seller.

**All four demo sellers are ours.** The market view reframes that against 296
real endpoints with nothing behind them, but it does not remove it.

**It has not been audited.** 158 tests and nine adversarial on chain checks are
not an audit, and calling them one would be the first dishonest sentence in this
repository.

## Repository layout

```
contracts/recourse/contract.py   The smart contract, in Algorand Python
contracts/build/                 Compiled TEAL and ARC-56, committed
src/x402.ts                      Facilitator config and paid route definitions
src/lib/signing.ts               Canonical JSON, sha256, ed25519
src/lib/chain.ts                 Algorand client, contract calls, box decoding
src/lib/recourse-client.ts       The buying agent: score, buy, verify, claim, select
src/lib/scoring.ts               Reliability, confidence, recommendation
src/lib/consistency.ts           Cross provider price agreement
src/agent/runner.ts              The agent loop
src/scripts/provider.ts          The provider CLI
src/routes/                      Paid, public and admin routes
public/                          The dashboard
```

## Further reading

| Document | What it covers |
|---|---|
| [WORKFLOW.md](WORKFLOW.md) | What actually happens, step by step, with every stage traced to the code that runs it |
| [SECURITY.md](SECURITY.md) | Every published security consideration and attack, answered against this code |
| [FEATURES.md](FEATURES.md) | The complete register of what is built and what is deliberately excluded |
| [DEMO.md](DEMO.md) | Walkthrough of the live demo |
| [RECORDING.md](RECORDING.md) | Script for the three minute demo video |
| [DEPLOY.md](DEPLOY.md) | Deployment and operator runbook |

## Licence

MIT
