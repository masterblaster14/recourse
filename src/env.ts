import { config } from "dotenv";
import algosdk from "algosdk";

config();

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : Number(v);
}

export const env = {
  algodUrl: opt("ALGOD_URL", "https://testnet-api.algonode.cloud"),
  algodToken: opt("ALGOD_TOKEN", ""),
  indexerUrl: opt("INDEXER_URL", "https://testnet-idx.algonode.cloud"),
  network: opt("NETWORK", "testnet"),
  /** CAIP-2 id the facilitator advertises on /supported for Algorand TestNet. */
  networkCaip2: opt(
    "NETWORK_CAIP2",
    "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
  ) as `${string}:${string}`,
  explorerBase: opt("EXPLORER_BASE", "https://lora.algokit.io/testnet"),

  facilitatorUrl: opt("FACILITATOR_URL", "https://facilitator.goplausible.xyz"),
  assetId: num("PAYMENT_ASSET_ID", 10458941),
  assetDecimals: num("PAYMENT_ASSET_DECIMALS", 6),
  assetSymbol: opt("PAYMENT_ASSET_SYMBOL", "USDC"),

  priceMicro: num("PRICE_MICRO", 1000),
  scorePriceMicro: num("SCORE_PRICE_MICRO", 1000),
  bondMicro: num("BOND_MICRO", 200_000),
  /** Must match PENALTY_MULTIPLIER in contracts/recourse/contract.py. */
  slashMultiplier: 9,
  maxStalenessS: num("SLA_MAX_STALENESS_S", 60),
  maxLatencyMs: num("SLA_MAX_LATENCY_MS", 800),
  /** How far in the past provider B back-dates its data_timestamp. 45 minutes. */
  staleOffsetS: num("STALE_OFFSET_S", 2700),

  appId: num("RECOURSE_APP_ID", 0),

  deployerMnemonic: opt("DEPLOYER_MNEMONIC"),
  deployerAddress: opt("DEPLOYER_ADDRESS"),
  treasuryAddress: opt("TREASURY_ADDRESS"),

  providerAAddress: opt("PROVIDER_A_ADDRESS"),
  providerAMnemonic: opt("PROVIDER_A_MNEMONIC"),
  providerASigningSk: opt("PROVIDER_A_SIGNING_SK"),
  providerBAddress: opt("PROVIDER_B_ADDRESS"),
  providerBMnemonic: opt("PROVIDER_B_MNEMONIC"),
  providerBSigningSk: opt("PROVIDER_B_SIGNING_SK"),

  agentAddress: opt("AGENT_ADDRESS"),
  agentMnemonic: opt("AGENT_MNEMONIC"),

  port: num("PORT", 3000),
  publicUrl: opt("PUBLIC_URL", `http://localhost:${num("PORT", 3000)}`).replace(/\/$/, ""),
  adminKey: opt("ADMIN_KEY", "dev"),
  databaseUrl: opt("DATABASE_URL"),
};

export function requireEnv(name: string): string {
  return req(name);
}

/** micro units -> human decimal string, e.g. 1000 -> "0.001" */
export function fromMicro(micro: number | bigint): number {
  return Number(micro) / 10 ** env.assetDecimals;
}
export function toMicro(amount: number): number {
  return Math.round(amount * 10 ** env.assetDecimals);
}

export function accountFromMnemonic(mnemonic: string): algosdk.Account {
  return algosdk.mnemonicToSecretKey(mnemonic);
}

/**
 * @x402/avm's toClientAvmSigner wants base64 of the 64-byte ed25519 secret key
 * (32-byte seed || 32-byte public key). That is exactly algosdk's `sk`.
 */
export function x402SecretKeyFromMnemonic(mnemonic: string): string {
  return Buffer.from(algosdk.mnemonicToSecretKey(mnemonic).sk).toString("base64");
}

export const txUrl = (txid: string) => `${env.explorerBase}/transaction/${txid}`;
export const appUrl = (appId: number | bigint) => `${env.explorerBase}/application/${appId}`;
export const acctUrl = (addr: string) => `${env.explorerBase}/account/${addr}`;
