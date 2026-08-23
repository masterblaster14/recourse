# Running the demo

Everything below happens for real on Algorand TestNet. Real payments, real
signatures, real money moving out of real collateral. Nothing is simulated
except the price numbers themselves, and the README says so.

---

## The idea in three sentences

x402 lets an AI agent pay for an API call by itself — no human clicking
approve. But it pays **first** and gets the data **second**, so if the data is
junk the money is simply gone. Recourse makes the seller put down a deposit, and
if the seller breaks its own published promise the agent takes compensation out
of that deposit automatically.

That's it. Everything else is detail.

---

## Before you present (5 minutes)

**1. Check everything is healthy.**

```bash
npm run preflight
```

Green across the board means accounts are funded, providers are registered, and
their signing keys match what's on chain. If anything is red, it tells you the
exact command to fix it.

**2. Refill the deposits.** A demo run drains the cheating provider on purpose,
so the *next* run has nothing left to take.

```bash
npm run topup
```

**3. Clear the observation history** so the score starts from nothing and you
can watch it build.

```bash
curl -X POST -H "x-admin-key: $ADMIN_KEY" https://recourse-api-production.up.railway.app/admin/reset
```

**4. Open the dashboard with the admin key** so the button works:

```
https://recourse-api-production.up.railway.app/?key=YOUR_ADMIN_KEY
```

Share the plain URL (no `?key=`) with anyone who should watch but not trigger.

---

## Who the four providers are

All four sell the same thing: an ALGO/USD price. All four have staked the same
deposit. All four promise the same SLA — *"my data will never be more than 60
seconds old."*

They differ only in whether they keep that promise, and whether they admit it.

| Provider | What it does | Can it be caught? |
|---|---|---|
| **Acme Price Feed** | Fresh data, honest timestamp | Nothing to catch |
| **Meridian Feed** | Fresh data, honest timestamp | Nothing to catch |
| **Northwind Oracle** | 45-minute-old data, and **says so** in the signed timestamp | **Yes — provably.** It signed a confession |
| **Cerberus Data** | The same 45-minute-old data, but stamps it **"just now"** | **Not by proof.** It passes every check |

Northwind and Cerberus are serving *identical stale data*. The only difference
is that one is honest about it. That single difference decides whether the
system can take its money — and it is the most important thing in the demo.

---

### And a fifth card that is not ours

The dashboard lists a fifth provider marked **Independent · not ours**. That is
an unrelated wallet that registered itself through the CLI, with its own price
and its own staleness bound, and staked its own bond. Nobody approved it —
`register` and `deposit_bond` key off `Txn.sender`, so the registry has no admin
who *could* approve or refuse anyone.

It shows facts and no reliability score, because we have never bought from it. A
registry listing is not evidence about anybody's uptime, and inventing a number
there would be exactly the dishonesty this project argues against.

If someone asks whether anyone else can join: that card is the answer, and
`npm run provider:register` is how they did it.

---

## The demo, step by step

### Step 1 — show that paying is real (20 seconds)

```bash
curl -i https://recourse-api-production.up.railway.app/feed/compliant
```

You get **HTTP 402 Payment Required**. The header says what it costs, which
asset, which network, and which wallet gets paid.

> "This is x402. The endpoint doesn't say 'log in' — it says 'pay me 0.001 USDC
> on Algorand and I'll answer.' No human is involved on either side."

### Step 2 — press the button

On the dashboard, press **Start the agent**.

> "That button doesn't buy anything. It starts an autonomous agent that holds
> its own wallet and its own spending limit. From here on, no human approves any
> individual payment — it decides who to pay, pays, checks what it got, and
> complains when it's cheated."

### Step 3 — watch it shop before it buys

The first thing the agent does is **pay for four risk reports** — one per
provider.

> "Before it spends anything on data, it buys information about who it's about
> to buy from. How much deposit is behind each one, how many failures that
> covers, what they've promised."

### Step 4 — watch it explore (about a minute)

It cycles through all four, paying each one in turn.

> "It has no history on any of these yet, so it tries them all. Notice it's
> willing to pay a complete unknown — because the **deposit**, not a reputation
> nobody has on day one, is what protects it. That's what lets a brand-new
> provider get its first customer."

**Point at the live feed.** Green rows are clean responses. Red rows are
violations.

### Step 5 — the honest cheat gets caught (the first claim)

Northwind's rows go red: *"staleness: 2705s old vs 60s allowed."* A **CLAIM**
row follows immediately, with a transaction link.

> "It sold 45-minute-old data and signed a timestamp admitting it. That
> signature is a confession — the contract checks it, sees the data breaches the
> provider's own published limit, and takes the money. The agent gets its 0.001
> back and the provider loses another 0.009 as a penalty. Cheating on a
> one-tenth-of-a-cent sale just cost ten times that."

**Click the transaction link.** It opens on Lora. It's real.

**Point at Northwind's deposit bar** — it's visibly shrinking.

### Step 6 — the clever cheat that cannot be caught

Point at **Cerberus Data**. Every single one of its rows is **green**. All six
checks pass.

> "Cerberus is selling the exact same stale data as Northwind. The only
> difference is that it lies about the timestamp. Its signature is valid, its
> hash matches, its timestamp looks fresh. There is **no cryptographic way** to
> catch it, and we don't pretend otherwise — its deposit is untouched and stays
> untouched."

*Now point at the divergence number on its card, sitting around 2%.*

> "But it can't hide from the market. Every provider publishes what the price
> was at a moment it names. Cerberus keeps claiming that right now the price is
> what it actually was 45 minutes ago — so it disagrees with everybody else
> about a moment it chose itself. That's not proof, so it never touches the
> deposit. It's evidence, so it destroys the score."

### Step 7 — the moment that matters (around call 20)

A green banner drops across the routing panel. Both cheats are now in black
**EXCLUDED** lanes.

> "There it is. The agent has stopped paying both of them — and for two
> completely different reasons.
>
> Northwind was **proved** guilty, so its deposit is gone: 0.10 down to zero.
>
> Cerberus was never proved guilty — six out of six checks passed, deposit fully
> intact — but the agent won't touch it either.
>
> That's the whole system. Proof takes your money. Evidence takes your
> customers."

### Step 8 — the market it's for

Scroll to **The live x402 market**.

> "This isn't a toy with providers we invented. This reads the public x402
> catalogue — every endpoint an agent could pay right now. Three hundred of
> them. Two have any deposit behind them: ours. Two hundred and ninety-eight
> have none.
>
> The busiest one has taken seventy-five thousand payments. If any of those
> responses were junk, that money was simply gone. That's the gap, and it's not
> hypothetical."

---

## The panel to point at

The **What the agent is doing** card at the top fills in live, one purchase at a
time. Seven stages, and the three worth narrating are the ones that are usually
invisible:

| Stage | What to say |
|---|---|
| **1 · Buy the risk data** | "It pays for the reputation record *before* it spends anything on data. Risk assessment is itself a paid machine-to-machine service." |
| **3 · Check the bill before paying it** | "It reads the 402 and refuses if the payee is not the party whose collateral it checked. If that fails, no transaction is ever built — the money never moves." |
| **5 · Confirm the money actually moved** | "The facilitator said it settled. The agent doesn't believe it — it looks the transaction up on chain itself. Right asset, right amount, from us, to them." |

Stage 7 stays greyed out and reads *"nothing to claim"* on a clean call. That is
the good outcome, and it is worth saying out loud: most calls are honest, and
the system says so plainly rather than manufacturing drama.

When Northwind is caught, stage 7 lights up with the refund, the penalty and the
transaction that moved them.

---

## If you have another minute

**Prove the contract can't be tricked:**

```bash
npm run test:chain
```

Nine attacks against the live contract — forging a signature, moving a
timestamp, rotating the signing key to void old evidence, widening the promise
after the fact, pulling the deposit before a claim lands, claiming the same
response twice. All rejected. One genuine claim in the middle, upheld, to prove
the rejections aren't just a broken contract.

**Check any endpoint in the world:**

```bash
curl "https://recourse-api-production.up.railway.app/preflight?url=https://x402.twit.sh/tweets/search"
```

> "This is the question an agent should ask before paying anyone: if this thing
> lies to me, do I get anything back?"

---

## Questions you will get

**"Isn't the chain just recording what your server decided?"**
No. Open [`contract.py`](contracts/recourse/contract.py) at `submit_claim`. The
contract runs the signature check itself and does the timestamp arithmetic
itself. There's no privileged caller and no "this was a breach" flag to set —
anyone can submit, and it only pays out if the maths holds.

**"Your stale provider signs the true old time. What if it lied?"**
That's Cerberus, and it's live. It cannot be slashed. Caught by market
consistency instead, and scored rather than punished — see step 6.

**"Are you reversing the x402 payment?"**
No, and we never claim to. That payment settled and is final. Compensation comes
out of the provider's deposit, capped at what's actually in it.

**"What if the provider just doesn't answer?"**
Then there's no signature, so there's nothing to prove and we can't take
anything. It's marked down in the score but not slashed. That's the one real gap
and the README specifies exactly how a challenge window closes it in v2.

**"Who ran the providers?"**
We did — all four. That's a fair criticism of the demo and the reason the
ecosystem view exists: the mechanism is pointed at 300 real endpoints, not just
ours. Anyone can register and stake against the same contract; nothing about it
is privileged to us.

**"Why does the good provider only say 'caution'?"**
Because 17 clean calls isn't proof of anything. The score reports the worst case
the evidence supports, not the flattering average — it takes roughly 75 clean
calls to earn a "buy". A score that hands out top marks after 17 calls is lying
to the thing spending the money.

---

## If something breaks

**The button does nothing** — the admin key is missing. Reopen with `?key=...`.

**Payments fail** — check the facilitator is up:
`curl https://facilitator.goplausible.xyz/supported`

**No claims appear** — the cheating provider's deposit is empty from a previous
run. `npm run topup`.

**Everything is down** — run it locally. `npm start`, then open
`http://localhost:3000/?key=...`. It's the same contract and the same chain;
only the web host changes.

**Fallback with no UI at all** — the terminal version tells the same story:

```bash
npm run demo -- --calls 40
```
