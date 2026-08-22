/**
 * Operator routes, guarded by ADMIN_KEY.
 *
 * /admin/demo is the one that matters on stage: it starts the buying agent
 * inside this process, so a judge can click one button on the hosted URL and
 * watch real x402 payments and real claims happen live.
 */
import { Hono } from "hono";
import algosdk from "algosdk";
import { env, fromMicro, txUrl } from "../env.ts";
import { clearHistory, log, publish, now } from "../lib/bus.ts";
import { accountInfo, depositBond, readProvider } from "../lib/chain.ts";
import { store } from "../lib/db.ts";
import { providerAccount, providers } from "../lib/providers.ts";
import { invalidateScore, scoreFor } from "../lib/service.ts";
import { isRunning, runDemo } from "../agent/runner.ts";

export const adminRoutes = new Hono();

adminRoutes.use("*", async (c, next) => {
  const key = c.req.header("x-admin-key") ?? c.req.query("key");
  if (!env.adminKey || key !== env.adminKey) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

/** Kick off a live run. Returns immediately; watch /events for progress. */
adminRoutes.post("/demo", async c => {
  if (isRunning()) return c.json({ error: "a demo run is already in progress" }, 409);

  type DemoBody = { calls?: number; pauseMs?: number };
  const body: DemoBody = await c.req.json<DemoBody>().catch(() => ({}) as DemoBody);
  const calls = Math.max(1, Math.min(200, Number(body.calls ?? c.req.query("calls") ?? 30)));
  const pauseMs = Math.max(0, Math.min(5000, Number(body.pauseMs ?? 0)));

  // Derive the base URL from the request rather than PUBLIC_URL, so the agent
  // buys from the host it was actually reached on. One less deploy footgun.
  const origin = new URL(c.req.url).origin;

  runDemo({ calls, pauseMs, baseUrl: origin }).catch(err => {
    log("error", `demo run failed: ${String((err as Error)?.message ?? err)}`);
  });

  return c.json({ started: true, calls, watch: "/events" });
});

/** Clear observed samples and the local ledger. Does not touch the chain. */
adminRoutes.post("/reset", async c => {
  if (isRunning()) return c.json({ error: "cannot reset while a demo is running" }, 409);
  await store().reset();
  clearHistory();
  invalidateScore();
  publish({ type: "log", at: now(), level: "info", message: "observed samples cleared — on-chain state untouched" });
  return c.json({ ok: true, note: "on-chain bonds, claims and counters are unchanged" });
});

/**
 * Re-stake a provider whose bond has been drained, so the demo can be run
 * again. Useful between rehearsals; the on-chain claim history is preserved.
 */
adminRoutes.post("/topup", async c => {
  type TopupBody = { provider?: string; amountMicro?: number };
  const body: TopupBody = await c.req.json<TopupBody>().catch(() => ({}) as TopupBody);
  const amountMicro = Math.max(1, Number(body.amountMicro ?? env.bondMicro));
  const targets = body.provider
    ? providers().filter(p => p.address === body.provider)
    : providers();

  if (targets.length === 0) return c.json({ error: "unknown provider" }, 404);

  const results: unknown[] = [];
  for (const p of targets) {
    try {
      const account = providerAccount(p);
      const held = await accountInfo(p.address);
      const holding = held.assets.find(a => a.assetId === env.assetId);
      if (!holding || holding.amount < amountMicro) {
        results.push({
          provider: p.address, label: p.label, ok: false,
          error: `insufficient ${env.assetSymbol}: has ${fromMicro(holding?.amount ?? 0)}, needs ${fromMicro(amountMicro)}`,
        });
        continue;
      }
      const res = await depositBond(account, {
        appId: env.appId, assetId: env.assetId, amountMicro,
      });
      invalidateScore(p.address);
      results.push({
        provider: p.address, label: p.label, ok: true,
        txid: res.txid, explorer: txUrl(res.txid), bond: fromMicro(res.bondMicro),
      });
    } catch (err) {
      results.push({ provider: p.address, label: p.label, ok: false, error: String((err as Error).message) });
    }
  }
  return c.json({ results });
});

/** Operator view of every account and its on-chain provider record. */
adminRoutes.get("/status", async c => {
  const out: unknown[] = [];
  for (const p of providers()) {
    const onchain = env.appId ? await readProvider(env.appId, p.address) : null;
    const acct = await accountInfo(p.address).catch(() => null);
    const score = env.appId ? await scoreFor(p.address, { fresh: true }).catch(() => null) : null;
    out.push({
      label: p.label,
      address: p.address,
      variant: p.variant,
      registered: Boolean(onchain),
      bond: onchain ? fromMicro(onchain.bondMicro) : 0,
      active: onchain?.active ?? false,
      claims: onchain?.claimCount ?? 0,
      successes: onchain?.successCount ?? 0,
      algo: acct ? acct.microAlgos / 1e6 : null,
      asset: acct?.assets.find(a => a.assetId === env.assetId)?.amount ?? null,
      reliability: score?.reliability ?? null,
      recommendation: score?.recommendation ?? null,
    });
  }

  const agent = env.agentMnemonic
    ? await accountInfo(algosdk.mnemonicToSecretKey(env.agentMnemonic).addr.toString()).catch(() => null)
    : null;

  return c.json({
    app_id: env.appId,
    providers: out,
    agent: agent
      ? {
          address: agent.address,
          algo: agent.microAlgos / 1e6,
          asset: agent.assets.find(a => a.assetId === env.assetId)?.amount ?? null,
        }
      : null,
  });
});
