/**
 * The read path shared by the paid /score endpoint, the free /providers
 * directory, and the agent's own routing loop. One place that joins on-chain
 * truth (bond, SLA, claim counters) with off-chain observation (samples).
 */
import { env } from "../env.ts";
import { readProvider, readGlobalState, type ProviderState } from "./chain.ts";
import { store } from "./db.ts";
import { computeConsistency } from "./consistency.ts";
import { buildScoreRecord, type ScoreRecord } from "./scoring.ts";
import { providers, providerByAddress, slaFor, type DemoProvider } from "./providers.ts";

const SCORE_WINDOW_HOURS = 24;

/** Short-lived cache: the demo hammers this and every miss is a box read. */
const cache = new Map<string, { at: number; value: ScoreRecord }>();
const CACHE_MS = 1200;

export function invalidateScore(address?: string): void {
  if (address) cache.delete(address);
  else cache.clear();
}

export async function scoreFor(
  address: string,
  opts: { fresh?: boolean } = {},
): Promise<ScoreRecord | null> {
  if (!opts.fresh) {
    const hit = cache.get(address);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  }

  if (!env.appId) throw new Error("RECOURSE_APP_ID is not set — deploy the contract first");

  const onchain: ProviderState | null = await readProvider(env.appId, address);
  if (!onchain) return null;

  const known: DemoProvider | undefined = providerByAddress(address);
  const row = await store().getProvider(address);
  const agg = await store().aggregate(address, SCORE_WINDOW_HOURS);

  // Consistency is a statement about disagreement, so it needs every
  // provider's observations, not just this one's.
  const all = await store().allSamples(SCORE_WINDOW_HOURS);
  agg.consistency = computeConsistency(all).get(address);

  // Who has actually paid this provider, so the score can say how broad the
  // evidence is rather than only how much of it there is.
  const counterparties = await store().counterparties(address);

  const record = buildScoreRecord({
    label: known?.label ?? row?.label ?? "Unknown provider",
    endpoint: known?.endpoint ?? row?.endpoint ?? "",
    onchain,
    agg,
    appId: env.appId,
    counterparties,
  });

  cache.set(address, { at: Date.now(), value: record });
  return record;
}

export async function allScores(opts: { fresh?: boolean } = {}): Promise<ScoreRecord[]> {
  const out: ScoreRecord[] = [];
  for (const p of providers()) {
    if (!p.address) continue;
    const s = await scoreFor(p.address, opts);
    if (s) out.push(s);
  }
  return out;
}

/** The free directory view. Deliberately a summary, not the full risk record. */
export type ProviderSummary = {
  provider: string;
  label: string;
  blurb: string;
  endpoint: string;
  variant: string;
  price: number;
  bond: number;
  bond_micro: number;
  active: boolean;
  registered: boolean;
  reliability: number;
  reliability_lower_bound: number;
  recommendation: string;
  confidence: string;
  samples: number;
  passes: number;
  claims: number;
  /** Median disagreement with the rest of the market, as a fraction. */
  divergence: number | null;
  divergence_conclusive: boolean;
  /** Distinct paying counterparties, self-payments excluded. */
  distinct_payers: number;
  /** True while every observation traces back to one payer. Caps confidence. */
  single_source: boolean;
};

export async function providerDirectory(): Promise<ProviderSummary[]> {
  const out: ProviderSummary[] = [];
  for (const p of providers()) {
    const s = p.address ? await scoreFor(p.address) : null;
    out.push({
      provider: p.address,
      label: p.label,
      blurb: p.blurb,
      endpoint: p.endpoint,
      variant: p.variant,
      price: s?.price ?? env.priceMicro / 10 ** env.assetDecimals,
      bond: s?.bond ?? 0,
      bond_micro: s?.bond_micro ?? 0,
      active: s?.active ?? false,
      registered: s !== null,
      reliability: s?.reliability ?? 0,
      reliability_lower_bound: s?.reliability_lower_bound ?? 0,
      recommendation: s?.recommendation ?? "avoid",
      confidence: s?.confidence ?? "low",
      samples: s?.observed.samples ?? 0,
      passes: s?.observed.passes ?? 0,
      claims: s?.onchain.claim_count ?? 0,
      divergence: s?.observed.price_divergence ?? null,
      divergence_conclusive: s?.observed.divergence_conclusive ?? false,
      distinct_payers: s?.counterparties.distinct_payers ?? 0,
      single_source: s?.counterparties.single_source ?? true,
    });
  }
  return out;
}

export async function registryStats() {
  if (!env.appId) return null;
  const g = await readGlobalState(env.appId);
  const payments = await store().countPayments();
  return {
    app_id: env.appId,
    treasury: g.treasury,
    asset_id: g.assetId,
    provider_count: g.providerCount,
    claim_count: g.claimCount,
    total_bonded_micro: g.totalBonded,
    total_slashed_micro: g.totalSlashed,
    x402_payments_observed: payments.count,
    x402_volume_micro: payments.totalMicro,
  };
}

export function publishedSlas() {
  return providers().map(p => ({ provider: p.address, label: p.label, sla: slaFor(p) }));
}
