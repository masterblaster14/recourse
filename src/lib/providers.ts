/**
 * The two demo providers.
 *
 * They run the same code. The only difference is one config flag: provider B
 * signs a `data_timestamp` 45 minutes in the past while publishing an SLA that
 * promises 60 seconds. Every response it signs is therefore a provable,
 * self-incriminating violation of its own commitment. That is the whole demo,
 * and it needs no narration.
 *
 * A price feed, deliberately. Stale price data obviously costs money, so nobody
 * has to be talked into caring about staleness.
 */
import { randomBytes } from "node:crypto";
import algosdk from "algosdk";
import { env } from "../env.ts";
import { priceAt } from "./price-series.ts";
import {
  canonicalJson,
  claimMessage,
  ed25519Sign,
  publicKeyFromSecret,
  responseHash,
  slaHash,
} from "./signing.ts";

/**
 * Three behaviours, chosen to span exactly what this system can and cannot
 * prove:
 *
 *   compliant  fresh data, honest timestamp        -> passes everything
 *   stale      old data, honest timestamp          -> PROVABLE breach, slashable
 *   forger     old data, timestamp forged to now   -> passes all six checks
 *
 * The forger is the honest answer to the sharpest criticism of this design:
 * staleness is measured against a timestamp the provider itself controls, so a
 * provider that simply lies about the time defeats every cryptographic check.
 * It cannot be slashed and we do not pretend otherwise. It is caught instead by
 * cross-provider price consistency, which is an observation rather than a proof
 * — and is scored, never slashed.
 */
export type Variant = "compliant" | "stale" | "forger";

export type DemoProvider = {
  key: "A" | "B" | "C" | "D";
  variant: Variant;
  label: string;
  blurb: string;
  address: string;
  mnemonic: string;
  signingSk: string;
  pubkey: Buffer;
  path: string;
  endpoint: string;
};

/**
 * The published SLA — the exact set of commitments the provider stakes against.
 *
 * Deliberately does NOT include the endpoint URL. The hash of this document is
 * written on chain at register time, so anything inside it is frozen until the
 * provider re-registers. Binding the hostname in here would mean moving the
 * service from localhost to a deployed URL silently invalidated every provider's
 * on-chain commitment. What a provider is accountable for is its price and its
 * bounds, not where it happens to be hosted; discovery is what /providers and
 * the Bazaar catalog are for.
 */
export type Sla = {
  version: number;
  provider: string;
  network: string;
  asset: { id: number; symbol: string; decimals: number };
  price_micro: number;
  max_staleness_s: number;
  max_latency_ms: number;
  required_fields: string[];
  signing: { algorithm: string; message: string; pubkey_b64: string };
};

export const REQUIRED_FIELDS = ["symbol", "price", "data_timestamp"] as const;

const LABELS = {
  A: "Acme Price Feed",
  B: "Northwind Oracle",
  C: "Cerberus Data",
  D: "Meridian Feed",
} as const;

const BLURBS: Record<Variant, string> = {
  compliant: "Fresh data, honest timestamp. Honours its published SLA.",
  stale:
    "Serves 45-minute-old data and admits it in the signed timestamp. A provable breach of its own SLA on every call — slashable.",
  forger:
    "Serves the same 45-minute-old data but stamps it as current. Passes all six checks and CANNOT be slashed. Caught only by cross-provider price consistency.",
};

const KEYED = {
  A: { address: () => env.providerAAddress, mnemonic: () => env.providerAMnemonic, sk: () => env.providerASigningSk },
  B: { address: () => env.providerBAddress, mnemonic: () => env.providerBMnemonic, sk: () => env.providerBSigningSk },
  C: { address: () => env.providerCAddress, mnemonic: () => env.providerCMnemonic, sk: () => env.providerCSigningSk },
  D: { address: () => env.providerDAddress, mnemonic: () => env.providerDMnemonic, sk: () => env.providerDSigningSk },
} as const;

function build(key: "A" | "B" | "C" | "D", variant: Variant, slug: string): DemoProvider {
  const address = KEYED[key].address();
  const mnemonic = KEYED[key].mnemonic();
  const signingSk = KEYED[key].sk();
  const path = `/feed/${slug}`;
  return {
    key,
    variant,
    label: LABELS[key],
    blurb: BLURBS[variant],
    address,
    mnemonic,
    signingSk,
    pubkey: signingSk ? publicKeyFromSecret(signingSk) : Buffer.alloc(32),
    path,
    endpoint: `${env.publicUrl}${path}`,
  };
}

let _providers: DemoProvider[] | null = null;

export function providers(): DemoProvider[] {
  if (!_providers) {
    _providers = [
      build("A", "compliant", "compliant"),
      build("D", "compliant", "compliant-2"),
      build("B", "stale", "stale"),
      build("C", "forger", "forger"),
    ];
  }
  return _providers;
}

/** Routes /feed/:slug. Two providers share the `compliant` behaviour, so the
 *  path slug rather than the variant is what identifies one. */
export function providerBySlug(slug: string): DemoProvider | undefined {
  return providers().find(p => p.path === `/feed/${slug}`);
}

export function providerByVariant(variant: Variant): DemoProvider | undefined {
  return providers().find(p => p.variant === variant);
}

export function providerByAddress(address: string): DemoProvider | undefined {
  return providers().find(p => p.address === address);
}

export function providerAccount(p: DemoProvider): algosdk.Account {
  return algosdk.mnemonicToSecretKey(p.mnemonic);
}

/**
 * The published SLA. Its sha256 is committed on chain at register time, so the
 * API cannot quietly serve one SLA to agents and commit to a different one.
 */
export function slaFor(p: DemoProvider): Sla {
  return {
    version: 1,
    provider: p.address,
    network: env.networkCaip2,
    asset: { id: env.assetId, symbol: env.assetSymbol, decimals: env.assetDecimals },
    price_micro: env.priceMicro,
    max_staleness_s: env.maxStalenessS,
    max_latency_ms: env.maxLatencyMs,
    required_fields: [...REQUIRED_FIELDS],
    signing: {
      algorithm: "ed25519",
      message: "request_id(32) || sha256(canonical_json(data))(32) || uint64_be(data_timestamp)",
      pubkey_b64: p.pubkey.toString("base64"),
    },
  };
}

export function slaHashFor(p: DemoProvider): Buffer {
  return slaHash(slaFor(p));
}

// ------------------------------------------------------------- the feed data

export type FeedData = {
  symbol: string;
  price: number;
  data_timestamp: number;
};

export type SignedFeedResponse = FeedData & {
  request_id: string;
  response_hash: string;
  signature: string;
  provider: string;
  sla_hash: string;
  served_at: number;
};

/**
 * Produce one signed response. `variant` decides only the timestamp: everything
 * else, including the signature, is produced by identical code.
 */
export function serveFeed(p: DemoProvider): SignedFeedResponse {
  const nowS = Math.floor(Date.now() / 1000);

  // How old the data actually is, and what the provider is willing to admit.
  // The forger is defined entirely by the gap between these two lines.
  const actualLagS = p.variant === "compliant" ? 0 : env.staleOffsetS;
  const dataTimestamp = p.variant === "stale" ? nowS - env.staleOffsetS : nowS;

  const data: FeedData = {
    symbol: "ALGO/USD",
    price: priceAt(actualLagS, nowS),
    data_timestamp: dataTimestamp,
  };

  const requestId = randomBytes(32);
  const hash = responseHash(data);
  const signature = ed25519Sign(claimMessage(requestId, hash, dataTimestamp), p.signingSk);

  return {
    ...data,
    request_id: requestId.toString("hex"),
    response_hash: hash.toString("hex"),
    signature: signature.toString("base64"),
    provider: p.address,
    sla_hash: `0x${slaHashFor(p).toString("hex")}`,
    served_at: nowS,
  };
}

/** The exact subset the response_hash commits to. Must match on both sides. */
export function dataOf(r: SignedFeedResponse | FeedData): FeedData {
  return {
    symbol: r.symbol,
    price: r.price,
    data_timestamp: r.data_timestamp,
  };
}

export { canonicalJson };
