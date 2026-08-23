/**
 * Free routes: the directory, the published SLAs, health, the claim ledger, and
 * the live event stream the dashboard renders.
 *
 * /providers is deliberately a summary. The full risk record — SLA commitment
 * hash, coverage maths, per-check breakdown, on-chain counters — is what /score
 * charges for.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { env, acctUrl, appUrl, fromMicro, txUrl } from "../env.ts";
import { history, subscribe } from "../lib/bus.ts";
import { chainHealthy, readProvider } from "../lib/chain.ts";
import { store } from "../lib/db.ts";
import { providers, slaFor } from "../lib/providers.ts";
import { ecosystem, preflight } from "../lib/bazaar.ts";
import { proofView } from "../lib/proof.ts";
import { providerDirectory, publishedSlas, registryStats } from "../lib/service.ts";
import { EXPLORE_SAMPLES } from "../lib/recourse-client.ts";
import { isRunning } from "../agent/runner.ts";
import { paidPaths } from "../x402.ts";

export const publicRoutes = new Hono();

publicRoutes.get("/health", async c => {
  const chain = await chainHealthy();
  return c.json({
    status: chain.ok ? "ok" : "degraded",
    service: "recourse",
    network: env.network,
    network_caip2: env.networkCaip2,
    chain: chain.ok ? { connected: true, last_round: chain.round } : { connected: false, error: chain.error },
    app_id: env.appId || null,
    app_url: env.appId ? appUrl(env.appId) : null,
    facilitator: env.facilitatorUrl,
    asset: { id: env.assetId, symbol: env.assetSymbol, decimals: env.assetDecimals },
    store: store().kind,
    /** The autonomous buyer. No human approves its payments. */
    agent: env.agentAddress || null,
    repo: env.repoUrl || null,
    demo_running: isRunning(),
    // Generated from the route table, never hand-listed. This was stale at
    // three entries while five routes were behind the paywall — the same
    // failure /x402 had, and the same fix.
    paid_endpoints: [...paidPaths()].sort().map(path => `GET ${path}`),
    price: {
      score: fromMicro(env.scorePriceMicro),
      feed: fromMicro(env.priceMicro),
    },
  });
});

publicRoutes.get("/providers", async c => {
  const list = await providerDirectory();
  return c.json({
    app_id: env.appId || null,
    asset: { id: env.assetId, symbol: env.assetSymbol },
    explore_samples: EXPLORE_SAMPLES,
    providers: list.map(p => ({ ...p, explorer: p.provider ? acctUrl(p.provider) : null })),
  });
});

/**
 * The published SLA document. Its sha256 is committed on chain, so an agent can
 * check this against `sla_hash` from /score before trusting the signing key it
 * contains. That check is what stops the API quietly serving a weaker SLA than
 * the one the provider actually staked against.
 */
publicRoutes.get("/sla", async c => {
  const address = c.req.query("provider");
  if (!address) return c.json({ slas: publishedSlas() });

  const p = providers().find(x => x.address === address);
  if (p) return c.json({ provider: p.address, label: p.label, sla: slaFor(p) });

  // Registered by somebody else. We do not host their SLA document — they do —
  // but answering "unknown provider" about an address carrying a commitment on
  // chain would be false, and would contradict the directory that lists it.
  const onchain = env.appId ? await readProvider(env.appId, address).catch(() => null) : null;
  if (!onchain) return c.json({ error: "unknown provider", provider: address }, 404);

  return c.json({
    provider: address,
    label: "Independent provider",
    hosted_here: false,
    note:
      "Registered with its own terms. Its SLA document is published by the " +
      "provider, not by us — fetch it from them and check its sha256 against " +
      "sla_hash below before trusting the signing key inside.",
    commitment: {
      sla_hash: `0x${Buffer.from(onchain.slaHash).toString("hex")}`,
      pubkey_b64: Buffer.from(onchain.pubkey).toString("base64"),
      price_micro: onchain.priceMicro,
      max_staleness_s: onchain.maxStaleness,
      max_latency_ms: onchain.maxLatencyMs,
      bond_micro: onchain.bondMicro,
    },
  });
});

publicRoutes.get("/registry", async c => {
  try {
    const stats = await registryStats();
    if (!stats) return c.json({ error: "RECOURSE_APP_ID not set" }, 503);
    return c.json({
      ...stats,
      total_bonded: fromMicro(stats.total_bonded_micro),
      total_slashed: fromMicro(stats.total_slashed_micro),
      x402_volume: fromMicro(stats.x402_volume_micro),
      app_url: appUrl(stats.app_id),
      treasury_url: stats.treasury ? acctUrl(stats.treasury) : null,
    });
  } catch (err) {
    return c.json({ error: String((err as Error).message) }, 503);
  }
});

/**
 * Every transaction id that proves a part of this system actually ran.
 *
 * The file is a committed seed covering deployment and bonding. Run-scoped
 * proofs — a settled payment, an upheld claim — are backfilled from the store,
 * because the host filesystem is ephemeral: without this, every restart would
 * throw away the evidence of every run and the page would go back to reading
 * "awaiting first payment" on a system that has settled hundreds.
 */
/**
 * Every x402 endpoint an agent could pay today, and how much of that market has
 * any collateral behind it. Free, because the answer is mostly "none of it",
 * and that is the argument for this project existing.
 */
publicRoutes.get("/ecosystem", async c => {
  try {
    const view = await ecosystem(Number(c.req.query("limit") ?? 300));
    const compact = c.req.query("full") !== "1";
    return c.json(compact ? { ...view, entries: view.entries.slice(0, 60) } : view);
  } catch (err) {
    return c.json({ error: `bazaar unavailable: ${(err as Error).message}` }, 503);
  }
});

/** Pre-flight for any URL: what is an agent exposed to if it pays this? */
publicRoutes.get("/preflight", async c => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "missing ?url=" }, 400);
  try {
    return c.json(await preflight(url));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 503);
  }
});

publicRoutes.get("/proof", async c => {
  const view = proofView();
  try {
    if (!view.x402_payment) {
      const [latest] = await store().listPayments(1);
      if (latest?.txid) {
        view.x402_payment = {
          txid: latest.txid, at: latest.ts.toISOString(),
          note: "agent paid over x402 via the GoPlausible facilitator",
          url: txUrl(latest.txid),
        };
      }
    }
    if (!view.claim_upheld) {
      const [latest] = await store().listClaims(1);
      if (latest?.txid) {
        view.claim_upheld = {
          txid: latest.txid, at: latest.ts.toISOString(),
          note: `signed data ${latest.age_s}s old: refund + slash from bond`,
          url: txUrl(latest.txid),
        };
      }
    }
  } catch {
    // The seed alone is still a valid answer.
  }
  return c.json(view);
});

publicRoutes.get("/claims", async c => {
  const limit = Math.min(200, Number(c.req.query("limit") ?? 50));
  const rows = await store().listClaims(limit);
  return c.json({
    claims: rows.map(r => ({
      request_id: r.request_id,
      provider: r.provider,
      payer: r.payer,
      txid: r.txid,
      explorer: r.txid ? txUrl(r.txid) : null,
      refund: fromMicro(r.refund_micro),
      slash: fromMicro(r.slash_micro),
      refund_micro: r.refund_micro,
      slash_micro: r.slash_micro,
      age_s: r.age_s,
      ts: r.ts,
    })),
  });
});

publicRoutes.get("/payments", async c => {
  const limit = Math.min(200, Number(c.req.query("limit") ?? 50));
  const rows = await store().listPayments(limit);
  const totals = await store().countPayments();
  return c.json({
    count: totals.count,
    volume: fromMicro(totals.totalMicro),
    payments: rows.map(r => ({
      provider: r.provider,
      payer: r.payer,
      resource: r.resource,
      amount: fromMicro(r.amount_micro),
      txid: r.txid,
      explorer: r.txid ? txUrl(r.txid) : null,
      ts: r.ts,
    })),
  });
});

/** Server-sent events. Replays recent history so a late viewer is not blank. */
publicRoutes.get("/events", c =>
  streamSSE(c, async stream => {
    let closed = false;
    stream.onAbort(() => {
      closed = true;
    });

    for (const e of history(120)) {
      await stream.writeSSE({ data: JSON.stringify(e), event: e.type });
    }

    const queue: string[] = [];
    const unsubscribe = subscribe(e => queue.push(JSON.stringify(e)));

    try {
      while (!closed) {
        if (queue.length === 0) {
          await stream.sleep(120);
          // Comment frame keeps proxies from reaping an idle connection.
          if (queue.length === 0) await stream.write(": ping\n\n");
          continue;
        }
        const next = queue.shift()!;
        await stream.writeSSE({ data: next, event: JSON.parse(next).type });
      }
    } finally {
      unsubscribe();
    }
  }),
);
