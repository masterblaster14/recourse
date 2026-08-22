# Deploying Recourse

One Node service. No build step at deploy time — the contract is precompiled and
`contracts/build/` is committed, so the host needs Node only.

**Railway is the right target.** The service holds an open SSE stream to every
dashboard and runs the buying agent in-process, which is what makes "press the
button and watch real payments settle" work. Vercel's serverless functions time
out and cannot hold either. If you must use Vercel, put only a static copy of
the dashboard there and point it at the Railway API.

---

## Railway

### 1. Push the repo

```bash
git init && git add -A && git commit -m "Recourse"
gh repo create recourse --private --source=. --push
```

### 2. Create the service

New Project → Deploy from GitHub repo → pick the repo. `railway.json` and
`nixpacks.toml` are already in the repo, so no build config is needed.

### 3. Set the variables

Copy every value from your local `.env`, with two changes:

| Variable | Value |
|---|---|
| `PUBLIC_URL` | the Railway URL, e.g. `https://recourse-production.up.railway.app` — **no trailing slash** |
| `PORT` | leave unset; Railway injects it |

Everything else — `DEPLOYER_MNEMONIC`, `PROVIDER_A_*`, `PROVIDER_B_*`,
`AGENT_MNEMONIC`, `RECOURSE_APP_ID`, `PAYMENT_ASSET_ID`, `ADMIN_KEY` — carries
over unchanged.

```bash
# fastest path: pipe .env straight in
railway variables set $(grep -v '^#' .env | grep -v '^$' | grep -v '^PORT=' | xargs)
railway variables set PUBLIC_URL=https://<your-app>.up.railway.app
```

### 4. Optional: Postgres

Add the Postgres plugin and Railway injects `DATABASE_URL`; the service picks it
up and creates its own schema on boot. Without it the service uses an in-memory
store, which works fine — you just lose observed samples on restart. On-chain
state (bonds, claims, counters) is never affected either way.

### 5. Verify

```bash
curl https://<your-app>.up.railway.app/health
curl https://<your-app>.up.railway.app/proof
curl -i https://<your-app>.up.railway.app/feed/compliant   # expect HTTP 402
```

A 402 with a `PAYMENT-REQUIRED` header is the signal that the paywall is live.

### 6. Run the demo against production

```bash
npm run preflight
npm run demo -- --calls 26 --url https://<your-app>.up.railway.app
npm run readme            # regenerates the proof table from real transaction ids
```

Or open `https://<your-app>.up.railway.app/?key=<ADMIN_KEY>` and press
**Start the agent**. The `?key=` is remembered in localStorage, so share the
plain URL with anyone who should watch but not trigger.

### 7. Confirm the Bazaar catalog picked up the endpoints

The `@x402-avm/extensions` discovery metadata is attached to every 402, and
GoPlausible indexes a resource once a real payment against it settles. Endpoints
on `localhost` are never indexed — the URL has to be publicly reachable — so
this only works after deploying and running at least one paid call.

```bash
curl -s "https://facilitator.goplausible.xyz/discovery/resources?limit=200"   | grep -o "https://<your-app>.up.railway.app[^\"]*"
```

They should also appear in the public catalog UI at
<https://facilitator.goplausible.xyz/dashboard/leaderboards?cat=resources>.

---

## Docker (any host)

```bash
docker build -t recourse .
docker run -p 3000:3000 --env-file .env -e PUBLIC_URL=https://your.host recourse
```

---

## Between rehearsals

A demo run drains the violating provider's bond to zero on purpose. To reset:

```bash
npm run topup                                                  # re-stake both bonds
curl -X POST -H "x-admin-key: $ADMIN_KEY" https://<app>/admin/reset
```

`/admin/reset` clears observed samples only. On-chain bonds, claims and counters
are never touched — the claim history is real and stays real.

---

## Security note

`.env` holds four TestNet mnemonics. They are TestNet-only and hold nothing of
value, but `.env` is gitignored and should stay that way. `ADMIN_KEY` guards
`/admin/*`, which can spend the agent's balance by starting a run — treat it as
a real secret and rotate it if you paste it anywhere public.
