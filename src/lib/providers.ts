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
import {
  canonicalJson,
  claimMessage,
  ed25519Sign,
  publicKeyFromSecret,
  responseHash,
  slaHash,
} from "./signing.ts";

export type Variant = "compliant" | "stale";

export type DemoProvider = {
  key: "A" | "B";
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

function build(key: "A" | "B", variant: Variant): DemoProvider {
  const address = key === "A" ? env.providerAAddress : env.providerBAddress;
  const mnemonic = key === "A" ? env.providerAMnemonic : env.providerBMnemonic;
  const signingSk = key === "A" ? env.providerASigningSk : env.providerBSigningSk;
  const path = `/feed/${variant}`;
  return {
    key,
    variant,
    label: key === "A" ? "Acme Price Feed" : "Northwind Oracle",
    blurb:
      variant === "compliant"
        ? "Signs a current timestamp. Honours its published SLA."
        : "Signs data 45 minutes old while promising 60 seconds. Violates its own SLA on every call.",
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
  if (!_providers) _providers = [build("A", "compliant"), build("B", "stale")];
  return _providers;
}

export function providerByVariant(variant: string): DemoProvider | undefined {
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

/**
 * A simulated ALGO/USD mid price on a slow random walk. It is simulated on
 * purpose and the README says so: the point of these endpoints is to be
 * measured against an SLA, not to be an oracle.
 */
const BASE_PRICE = 0.1842;
let drift = 0;

function currentPrice(): number {
  drift += (Math.random() - 0.5) * 0.0006;
  drift = Math.max(-0.012, Math.min(0.012, drift));
  return Math.round((BASE_PRICE + drift) * 10_000) / 10_000;
}

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
  const dataTimestamp = p.variant === "stale" ? nowS - env.staleOffsetS : nowS;

  const data: FeedData = {
    symbol: "ALGO/USD",
    price: currentPrice(),
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
