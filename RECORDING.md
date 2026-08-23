# Recording the 3-minute demo

Everything below is real. No mockups, no pre-recorded segments, no edits that
hide a failure. If a run goes wrong, reset and run it again rather than cutting
around it — the whole argument of this project is that claims should be
checkable, and a doctored demo would be the one thing on the site that isn't.

---

## Before you press record

**1 · Reset the observed history.** Skip this and the video is boring: both
cheats are already caught from previous runs, so the agent correctly refuses to
buy from them and nothing dramatic happens.

```bash
curl -X POST https://recourse-api-production.up.railway.app/admin/reset \
  -H "x-admin-key: $ADMIN_KEY"
```

On-chain bonds, claims and counters are untouched — this only clears what the
agent has *observed*.

**2 · Top up the bonds** if Northwind is below ~0.15:

```bash
npm run topup -- --amount 0.2
```

Northwind is the only provider that can be slashed, and it loses 0.01 per
upheld claim. A run files 4–6 claims.

**3 · Open the dashboard with the admin key** so the button works:

```
https://recourse-api-production.up.railway.app/?key=YOUR_ADMIN_KEY
```

Then **reload once without the key in the URL** — it is saved to local storage,
and you do not want the key visible in the recording.

**4 · Set the call count to 30.** That is about 2½ minutes of agent activity,
which fits a 3-minute video with talking room at both ends.

**5 · Check the page is live** before recording: the chain pill should read
`TestNet · round …` with a green dot, and the events dot should be green.

---

## The 3-minute script

Timings are a guide. The agent takes about 5 seconds per call — mostly waiting
for Algorand to settle the payment — so there is natural room to talk.

### 0:00 – 0:25 · The problem, before you press anything

> "x402 lets an AI agent pay for an API call with no human approving it. But it
> pays **first**, and gets the response **after**. If that response is stale, or
> wrong, the money is gone and there is no recourse.
>
> That's what this fixes."

**Show:** the four provider cards.

> "Four sellers. All four sell the same thing — an ALGO/USD price. All four
> staked the same collateral on Algorand. And all four made the same promise:
> *my data will never be more than sixty seconds old.*
>
> They differ only in whether they keep it."

### 0:25 – 0:35 · Start it

**Click** *Start the agent*.

> "This is a real agent with its own wallet, spending real TestNet money. No
> human approves any individual payment — including me. I started it; I don't
> get a say in where it spends."

### 0:35 – 1:15 · The workflow panel — one purchase, end to end

**Show:** the *What the agent is doing* card as stages light up.

> "Every stage of one purchase. Three of these are worth calling out.
>
> **One** — it buys the *reputation data* before it buys anything else. Risk
> assessment is itself a paid machine-to-machine service.
>
> **Three** — it reads the payment demand and checks the address. If the seller
> asks it to pay somebody other than the party whose collateral it checked, no
> transaction is ever built. The money never moves.
>
> **Five** — the payment processor says it settled. The agent doesn't believe
> it. It looks the transaction up on the blockchain itself: right asset, right
> amount, from us, to them."

*(If a call passes cleanly, point at stage 7:)*

> "Stage seven stays grey — 'nothing to claim'. Most calls are honest, and it
> says so instead of manufacturing drama."

### 1:15 – 1:55 · The honest cheat gets caught

Northwind's first violation lands around call 3.

**Show:** the red `staleness` chip, then stage 7 lighting up, then Northwind's
bond bar shrinking.

> "There. Northwind served data forty-five minutes old against a sixty-second
> promise — **and it signed it**. That signature is a confession.
>
> The agent files it on chain. The contract checks Northwind's own signature
> against the blockchain's own clock, and pays compensation out of Northwind's
> own collateral. Refund plus a nine-times penalty, in one atomic transaction.
>
> Nobody arbitrated that. There is no dispute button and no admin. The seller's
> signature convicted it."

**Show:** the bond draining on the card — 0.200, 0.190, 0.180.

> "That's its collateral leaving, live."

### 1:55 – 2:30 · The clever cheat that cryptography cannot catch

**Show:** Cerberus's card — six green check chips, then the divergence line.

> "Now the interesting one. Cerberus serves the *same* forty-five-minute-old
> data — but stamps it *'just now'*.
>
> Look at its checks. All six pass. Valid signature, matching hash, timestamp
> inside the limit. **No cryptography on earth can catch that**, because a lie
> about time is indistinguishable from the truth when you only have one witness.
>
> So we don't use cryptography. We use the market."

**Show:** the divergence percentage.

> "Every provider publishes prices with timestamps. An honest-but-slow provider
> still sits on the same price curve — it's telling the truth about a different
> moment. A forger doesn't. It claims *now* while carrying an old value, so it
> disagrees with everyone else about the moment it named.
>
> And here's the deliberate part: **Cerberus loses every customer and keeps
> every penny of its bond.** Slashing on a statistic would be exactly the
> centralised judgement this project exists to remove.
>
> Proof takes money. Evidence takes customers."

### 2:30 – 2:50 · It routes away, permanently

**Show:** the routing panel — the excluded lanes and the banner.

> "Both cheats are now out of routing. The agent will not pay either of them
> again, and it decided that on its own, from evidence it paid for."

**Show:** the live market panel.

> "And this is the real x402 catalogue — every endpoint an agent could pay today.
> Three hundred of them. Four have any collateral behind them. These four."

### 2:50 – 3:00 · Close

> "Everything you just saw is on a public blockchain, and every claim on that
> page links to the transaction that proves it.
>
> x402 gave agents the ability to pay. This gives them a reason to trust what
> they're paying for."

---

## What to do if something doesn't fire

**Cerberus isn't flagged.** Roughly one run in fifteen. The forger is only
catchable when the price actually moved during the window it lied about — if
the market sat still for forty-five minutes, stale data is the same number as
fresh data, undetectable and also harmless. Reset and run again.

*If it happens on camera, say it.* "The price barely moved in the last
forty-five minutes, so this time the stale value is indistinguishable — and
also harmless. That's an honest limit, not a bug." That answer is stronger than
a re-shoot.

**No claims appear.** You forgot the reset, or Northwind's bond is empty. Check
its card — if the bond reads 0.000 it has been drained; run the topup.

**The events dot goes red.** The live stream dropped. Reload the page; the run
continues on the server and the panels repopulate.

**A compliant provider gets flagged.** Roughly one run in sixty. Reset and rerun
— do not ship a video that accuses an honest provider, even a simulated one.

---

## Things worth having open in other tabs

| Tab | Why |
|---|---|
| [The app on Lora](https://lora.algokit.io/testnet/application/769688356) | if anyone asks "is that really on chain" |
| `/proof` | every transaction that proves the system ran |
| `/ecosystem` | the 300-endpoint market view |

## Two questions you will get

**"Aren't all four providers yours?"** — Yes, and that is stated in the repo.
The point is the mechanism, and the ecosystem view reframes it against 296 real
endpoints with nothing behind them. Anyone can register: `npm run
provider:register`, no approval, because the contract has no admin.

**"What if a provider just doesn't respond?"** — Then it cannot be slashed. No
signature, no proof. That is the one hole that is still open, it is documented
in three places, and closing it needs a challenge window with a claimant
deposit. Saying that plainly is better than pretending.
