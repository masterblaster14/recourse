/**
 * The evidence file.
 *
 * The evaluation is explicitly "show us a real transaction on Lora", so the
 * transaction ids that prove each part of the system worked are recorded as
 * they happen rather than dug out of logs afterwards. Served at /proof and
 * used to generate the README table.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { env, acctUrl, appUrl, txUrl } from "../env.ts";

export type ProofEntry = { txid: string; at: string; note?: string };

export type ProofFile = {
  network: string;
  app_id: number;
  app_address: string;
  treasury: string;
  asset_id: number;
  asset_symbol: string;
  facilitator: string;
  app_created?: ProofEntry;
  app_funded?: ProofEntry;
  app_opt_in?: ProofEntry;
  provider_registered: Record<string, ProofEntry>;
  bond_deposited: Record<string, ProofEntry>;
  x402_payment?: ProofEntry;
  claim_upheld?: ProofEntry;
  record_success?: ProofEntry;
};

const PATH = resolve(process.cwd(), "proof.json");

function blank(): ProofFile {
  return {
    network: env.networkCaip2,
    app_id: env.appId,
    app_address: "",
    treasury: env.treasuryAddress,
    asset_id: env.assetId,
    asset_symbol: env.assetSymbol,
    facilitator: env.facilitatorUrl,
    provider_registered: {},
    bond_deposited: {},
  };
}

export function readProof(): ProofFile {
  if (!existsSync(PATH)) return blank();
  try {
    return { ...blank(), ...(JSON.parse(readFileSync(PATH, "utf8")) as ProofFile) };
  } catch {
    return blank();
  }
}

function write(p: ProofFile): void {
  writeFileSync(PATH, `${JSON.stringify(p, null, 2)}\n`, "utf8");
}

export function record(
  key: "app_created" | "app_funded" | "app_opt_in" | "x402_payment" | "claim_upheld" | "record_success",
  txid: string,
  note?: string,
  opts: { overwrite?: boolean } = {},
): void {
  const p = readProof();
  // Keep the first of each kind: the earliest proof is the one with history.
  if (p[key] && !opts.overwrite) return;
  p[key] = { txid, at: new Date().toISOString(), note };
  // Deliberately does not touch app_id. `env` is captured at module load, so
  // during a --force redeploy it still holds the previous id and writing it
  // here would silently undo what recordMeta just recorded.
  write(p);
}

export function recordProvider(
  kind: "provider_registered" | "bond_deposited",
  address: string,
  txid: string,
  note?: string,
): void {
  const p = readProof();
  p[kind][address] = { txid, at: new Date().toISOString(), note };
  write(p);
}

export function recordMeta(meta: Partial<ProofFile>): void {
  write({ ...readProof(), ...meta });
}

/**
 * Start a clean evidence file for a newly deployed application.
 *
 * Payments, claims and registrations from a previous app are not evidence for
 * this one, and a proof table mixing the two is worse than no table.
 */
export function resetProof(meta: Partial<ProofFile>): void {
  write({ ...blank(), ...meta });
}

/** Shape the dashboard and README consume. */
export function proofView() {
  const p = readProof();
  const link = (e?: ProofEntry) => (e ? { ...e, url: txUrl(e.txid) } : null);
  return {
    network: p.network,
    facilitator: p.facilitator,
    asset: { id: p.asset_id, symbol: p.asset_symbol },
    app: p.app_id ? { id: p.app_id, address: p.app_address, url: appUrl(p.app_id) } : null,
    treasury: p.treasury ? { address: p.treasury, url: acctUrl(p.treasury) } : null,
    app_created: link(p.app_created),
    app_funded: link(p.app_funded),
    app_opt_in: link(p.app_opt_in),
    provider_registered: Object.fromEntries(
      Object.entries(p.provider_registered).map(([k, v]) => [k, link(v)]),
    ),
    bond_deposited: Object.fromEntries(
      Object.entries(p.bond_deposited).map(([k, v]) => [k, link(v)]),
    ),
    x402_payment: link(p.x402_payment),
    claim_upheld: link(p.claim_upheld),
    record_success: link(p.record_success),
  };
}
