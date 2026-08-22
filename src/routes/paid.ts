/**
 * The three x402-paid routes.
 *
 * The handlers themselves are ordinary. Everything that makes them paid lives
 * in the middleware wired up in src/x402.ts; by the time a handler runs, money
 * has already moved on Algorand TestNet.
 */
import { Hono } from "hono";
import { env, fromMicro } from "../env.ts";
import { providerByVariant, serveFeed } from "../lib/providers.ts";
import { scoreFor } from "../lib/service.ts";

export const paidRoutes = new Hono();

/**
 * GET /score?provider=<address>
 *
 * The flagship. An agent about to spend money on an unknown provider buys this
 * first: how much bond stands behind the endpoint, how many failed calls that
 * bond can actually cover, what the provider committed to, and what we have
 * observed. It is worth paying for because the alternative is finding out
 * afterwards, when the money is already gone.
 */
paidRoutes.get("/score", async c => {
  const provider = c.req.query("provider");
  if (!provider) {
    return c.json({ error: "missing ?provider=<algorand address>" }, 400);
  }

  let record;
  try {
    record = await scoreFor(provider, { fresh: c.req.query("fresh") === "1" });
  } catch (err) {
    return c.json({ error: String((err as Error).message) }, 503);
  }

  if (!record) {
    return c.json(
      {
        error: "provider not registered with Recourse",
        provider,
        app_id: env.appId,
        hint: "an unregistered provider has posted no bond, so there is nothing to claim against",
      },
      404,
    );
  }

  return c.json(record);
});

/**
 * GET /feed/:variant
 *
 * Two demo providers running identical code. `compliant` signs the current
 * time; `stale` signs a timestamp 45 minutes old while publishing a 60 second
 * staleness bound. Every response the stale one signs is a provable breach of
 * its own commitment — which is exactly what makes the demo need no narration.
 */
paidRoutes.get("/feed/:variant", c => {
  const variant = c.req.param("variant");
  const provider = providerByVariant(variant);
  if (!provider) {
    return c.json({ error: `unknown feed variant '${variant}'`, available: ["compliant", "stale"] }, 404);
  }
  if (!provider.signingSk) {
    return c.json({ error: `provider ${variant} has no signing key configured` }, 503);
  }

  const body = serveFeed(provider);
  return c.json({
    ...body,
    // Extra metadata sits outside the signed payload: response_hash commits to
    // { symbol, price, data_timestamp } only.
    paid_via: {
      protocol: "x402",
      network: env.networkCaip2,
      asset: env.assetSymbol,
      asset_id: env.assetId,
      amount: fromMicro(env.priceMicro),
      facilitator: env.facilitatorUrl,
    },
  });
});
