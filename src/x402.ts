/**
 * x402 wiring.
 *
 * Three paid routes, all settling in the same ASA through the GoPlausible
 * facilitator on Algorand TestNet:
 *
 *   GET /score          paid to the Recourse treasury
 *   GET /feed/compliant paid to provider A
 *   GET /feed/stale     paid to provider B
 *
 * Note the payTo addresses differ per route. That is load bearing rather than
 * decorative: the agent's money genuinely goes to the provider it chose, which
 * is what makes a refund out of that provider's bond mean anything.
 *
 * The price is declared as an explicit AssetAmount rather than a "$0.001"
 * string. The money-string path resolves through a default asset table, and
 * being explicit about asset id and atomic amount removes a whole class of
 * "which token did it actually charge?" ambiguity.
 */
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";

/** The middleware owns the canonical shape; derive it rather than re-importing a name that moves. */
type RoutesConfig = Parameters<typeof paymentMiddleware>[0];
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402-avm/extensions";
import type { ResourceServerExtension } from "@x402/core/types";
import { env } from "./env.ts";
import { providers } from "./lib/providers.ts";

export const facilitatorClient = new HTTPFacilitatorClient({ url: env.facilitatorUrl });

export function buildResourceServer(): x402ResourceServer {
  const server = new x402ResourceServer(facilitatorClient).register(
    env.networkCaip2,
    new ExactAvmScheme(),
  );
  // Lists these endpoints in the GoPlausible Bazaar once a payment settles, so
  // an agent that has never heard of Recourse can still discover and buy them.
  server.registerExtension(bazaarResourceServerExtension as unknown as ResourceServerExtension);
  return server;
}

function priceFor(micro: number) {
  return { asset: String(env.assetId), amount: String(micro) };
}

const scoreDiscovery = declareDiscoveryExtension({
  output: {
    example: {
      provider: "PROVIDER_ALGORAND_ADDRESS",
      bond: 0.2,
      coverage_calls: 20,
      reliability: 0.9972,
      confidence: "high",
      recommendation: "buy",
    },
  },
});

const feedDiscovery = declareDiscoveryExtension({
  output: {
    example: {
      symbol: "ALGO/USD",
      price: 0.1842,
      data_timestamp: 1755880000,
      request_id: "hex 32 bytes",
      response_hash: "hex 32 bytes",
      signature: "base64 ed25519",
    },
  },
});

export function buildRoutes(): RoutesConfig {
  const [a, b] = providers();

  const routes: RoutesConfig = {
    "GET /score": {
      accepts: [
        {
          scheme: "exact",
          price: priceFor(env.scorePriceMicro),
          network: env.networkCaip2,
          payTo: env.treasuryAddress,
        },
      ],
      description:
        "Reliability score, bond coverage and published SLA for an x402 provider. " +
        "Tells an agent whether the thing it is about to buy is backed by anything.",
      mimeType: "application/json",
      serviceName: "Recourse",
      tags: ["x402", "risk", "reputation", "algorand", "sla"],
      extensions: scoreDiscovery,
    },
    "GET /feed/compliant": {
      accepts: [
        {
          scheme: "exact",
          price: priceFor(env.priceMicro),
          network: env.networkCaip2,
          payTo: a.address,
        },
      ],
      description: "ALGO/USD price feed, signed, SLA compliant. Demo provider A.",
      mimeType: "application/json",
      serviceName: "Acme Price Feed",
      tags: ["x402", "price-feed", "algorand", "bonded"],
      extensions: feedDiscovery,
    },
    "GET /feed/stale": {
      accepts: [
        {
          scheme: "exact",
          price: priceFor(env.priceMicro),
          network: env.networkCaip2,
          payTo: b.address,
        },
      ],
      description:
        "ALGO/USD price feed, signed, deliberately violating its own staleness SLA. Demo provider B.",
      mimeType: "application/json",
      serviceName: "Northwind Oracle",
      tags: ["x402", "price-feed", "algorand", "bonded"],
      extensions: feedDiscovery,
    },
  };

  return routes;
}

export function buildPaymentMiddleware() {
  return paymentMiddleware(buildRoutes(), buildResourceServer());
}

/** Decodes the base64 JSON the middleware puts in the PAYMENT-RESPONSE header. */
export type SettleInfo = {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
};

export function decodeSettleHeader(value: string | null | undefined): SettleInfo | null {
  if (!value) return null;
  try {
    const json = Buffer.from(value, "base64").toString("utf8");
    const parsed = JSON.parse(json) as SettleInfo;
    return parsed && typeof parsed.transaction === "string" ? parsed : null;
  } catch {
    return null;
  }
}
