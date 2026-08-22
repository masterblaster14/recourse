/**
 * Recourse — a risk layer for x402.
 *
 * One Node process serves the paid endpoints, the free directory, the live
 * event stream and the dashboard. Keeping it in one process is deliberate: the
 * buying agent runs here too, so clicking "run demo" on the hosted URL performs
 * real x402 payments on Algorand TestNet in front of whoever is watching.
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env, fromMicro } from "./env.ts";
import { log } from "./lib/bus.ts";
import { chainHealthy } from "./lib/chain.ts";
import { initStore, store } from "./lib/db.ts";
import { providers, slaFor } from "./lib/providers.ts";
import { adminRoutes } from "./routes/admin.ts";
import { paidRoutes } from "./routes/paid.ts";
import { publicRoutes } from "./routes/public.ts";
import { buildPaymentMiddleware, decodeSettleHeader } from "./x402.ts";
import { slaHash } from "./lib/signing.ts";

const app = new Hono();

app.use("*", cors({ origin: "*", exposeHeaders: ["PAYMENT-RESPONSE", "PAYMENT-REQUIRED"] }));
if (process.env.NODE_ENV !== "production") app.use("*", logger());

/**
 * Records every settled x402 payment, whoever made it. Registered before the
 * paywall so its post-`next` half runs after settlement headers are attached —
 * which means an outside agent's payment shows up on the dashboard too, not
 * just our own demo runs.
 */
app.use("*", async (c, next) => {
  await next();
  const settle = decodeSettleHeader(c.res.headers.get("PAYMENT-RESPONSE"));
  if (!settle?.success || !settle.transaction) return;

  const path = new URL(c.req.url).pathname;
  const provider = providers().find(p => p.path === path);
  const amountMicro = path === "/score" ? env.scorePriceMicro : env.priceMicro;
  try {
    await store().insertPayment({
      provider: provider?.address ?? env.treasuryAddress,
      payer: settle.payer ?? "unknown",
      resource: `${env.publicUrl}${path}`,
      amount_micro: amountMicro,
      txid: settle.transaction,
      ts: new Date(),
    });
  } catch {
    // Bookkeeping must never fail a paid request that already settled.
  }
});

// The x402 paywall. Everything below this line has already been paid for.
app.use(buildPaymentMiddleware());

app.route("/", paidRoutes);
app.route("/", publicRoutes);
app.route("/admin", adminRoutes);

app.get("/x402", c =>
  c.json({
    protocol: "x402",
    version: 2,
    network: env.networkCaip2,
    facilitator: env.facilitatorUrl,
    asset: { id: env.assetId, symbol: env.assetSymbol, decimals: env.assetDecimals },
    packages: ["@x402/avm", "@x402/core", "@x402/hono", "@x402/fetch", "@x402-avm/extensions"],
    paid_routes: [
      { method: "GET", path: "/score", price: fromMicro(env.scorePriceMicro), payTo: env.treasuryAddress },
      { method: "GET", path: "/feed/compliant", price: fromMicro(env.priceMicro), payTo: providers()[0]?.address },
      { method: "GET", path: "/feed/stale", price: fromMicro(env.priceMicro), payTo: providers()[1]?.address },
    ],
  }),
);

app.use("/*", serveStatic({ root: "./public" }));
app.get("/", serveStatic({ path: "./public/index.html" }));

app.notFound(c => c.json({ error: "not found", path: new URL(c.req.url).pathname }, 404));
app.onError((err, c) => {
  console.error("[error]", err);
  return c.json({ error: String(err?.message ?? err) }, 500);
});

async function main(): Promise<void> {
  const s = await initStore();

  for (const p of providers()) {
    if (!p.address) continue;
    await s.upsertProvider({
      address: p.address,
      label: p.label,
      endpoint: p.endpoint,
      pubkey_b64: p.pubkey.toString("base64"),
      variant: p.variant,
    });
  }

  const chain = await chainHealthy();

  serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, () => {
    const bar = "─".repeat(70);
    console.log(bar);
    console.log("  RECOURSE — risk layer for x402");
    console.log(bar);
    console.log(`  listening      http://0.0.0.0:${env.port}`);
    console.log(`  public url     ${env.publicUrl}`);
    console.log(`  network        ${env.networkCaip2}`);
    console.log(`  facilitator    ${env.facilitatorUrl}`);
    console.log(`  asset          ${env.assetSymbol} (${env.assetId})`);
    console.log(`  app id         ${env.appId || "NOT DEPLOYED — run npm run contract:deploy"}`);
    console.log(`  store          ${s.kind}`);
    console.log(`  algod          ${chain.ok ? `round ${chain.round}` : `UNREACHABLE (${chain.error})`}`);
    console.log(bar);
    console.log("  paid   GET /score?provider=<addr>   GET /feed/compliant   GET /feed/stale");
    console.log("  free   GET /providers  /sla  /registry  /claims  /payments  /health  /events");
    console.log(bar);
    for (const p of providers()) {
      const h = slaHash(slaFor(p)).toString("hex").slice(0, 16);
      console.log(`  ${p.variant.padEnd(9)} ${p.label.padEnd(20)} ${p.address || "(unset)"}  sla:${h}…`);
    }
    console.log(bar);
    log("info", "recourse api online");
  });
}

main().catch(err => {
  console.error("fatal:", err);
  process.exit(1);
});
