/**
 * The live x402 ecosystem, and how much of it is backed by anything.
 *
 * Recourse is easy to dismiss as two providers we made up arguing with each
 * other. So this reads the public GoPlausible Bazaar — every x402 endpoint an
 * agent could actually pay today — and cross-references each one's `payTo`
 * against the Recourse registry on chain.
 *
 * The honest discipline here: for endpoints we have never bought from, we
 * report only **facts we can observe** — price, asset, network, recipient,
 * settle count, and whether that recipient has collateral posted. We do not
 * rate anyone's reliability off a catalogue entry. Claiming to score a stranger's
 * uptime from a directory listing would undercut the entire point of measuring
 * things properly.
 */
import { env } from "../env.ts";
import { listRegisteredProviders, readProvider } from "./chain.ts";
import { coverageCalls } from "./scoring.ts";

type BazaarAccept = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  extra?: { decimals?: number; feePayer?: string; tag?: string };
};

type BazaarItem = {
  id: string;
  resourceUrl: string;
  method: string;
  description?: string;
  accepts?: BazaarAccept[];
  settleCount?: number;
  firstSeen?: string;
  lastSeen?: string;
};

export type EcosystemEntry = {
  url: string;
  method: string;
  description: string;
  network: string;
  network_label: string;
  asset: string;
  price: number | null;
  pay_to: string;
  settle_count: number;
  last_seen: string | null;
  /** Collateral posted with Recourse by this recipient, if any. */
  recourse: {
    bonded: boolean;
    bond: number;
    coverage_calls: number;
    active: boolean;
  };
};

export type EcosystemView = {
  fetched_at: string;
  source: string;
  total: number;
  bonded: number;
  unbonded: number;
  on_our_network: number;
  registry_app_id: number;
  networks: { network: string; label: string; count: number }[];
  entries: EcosystemEntry[];
  note: string;
};

const NETWORK_LABELS: Record<string, string> = {
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": "Algorand MainNet",
  "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=": "Algorand TestNet",
  "eip155:8453": "Base",
  "eip155:84532": "Base Sepolia",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana",
};

const label = (n: string) => NETWORK_LABELS[n] ?? n.split(":")[0];

let cache: { at: number; value: EcosystemView } | null = null;
const CACHE_MS = 5 * 60_000;

export function invalidateEcosystem(): void {
  cache = null;
}

export async function ecosystem(limit = 300): Promise<EcosystemView> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const source = `${env.facilitatorUrl}/discovery/resources?limit=${limit}`;
  const res = await fetch(source, { signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`bazaar returned ${res.status}`);
  const body = (await res.json()) as { items?: BazaarItem[] };
  const items = body.items ?? [];

  // One chain read for the whole registry rather than one per endpoint.
  const registered = env.appId ? await listRegisteredProviders(env.appId) : [];
  const registeredSet = new Set(registered);

  const bondCache = new Map<string, { bond: number; coverage: number; active: boolean }>();
  async function bondFor(address: string, priceMicro: number) {
    if (!registeredSet.has(address)) return { bond: 0, coverage: 0, active: false };
    const hit = bondCache.get(address);
    if (hit) return hit;
    const p = await readProvider(env.appId, address).catch(() => null);
    const value = p
      ? {
          bond: p.bondMicro / 10 ** env.assetDecimals,
          coverage: coverageCalls(p.bondMicro, p.priceMicro || priceMicro || 1),
          active: p.active,
        }
      : { bond: 0, coverage: 0, active: false };
    bondCache.set(address, value);
    return value;
  }

  const entries: EcosystemEntry[] = [];
  for (const item of items) {
    const a = item.accepts?.[0];
    if (!a) continue;
    const decimals = a.extra?.decimals ?? 6;
    const amount = Number(a.amount);
    const priceMicro = Number.isFinite(amount) ? amount : 0;
    const bond = await bondFor(a.payTo, priceMicro);

    entries.push({
      url: item.resourceUrl,
      method: item.method,
      description: (item.description ?? "").slice(0, 160),
      network: a.network,
      network_label: label(a.network),
      asset: a.asset,
      price: Number.isFinite(amount) ? amount / 10 ** decimals : null,
      pay_to: a.payTo,
      settle_count: item.settleCount ?? 0,
      last_seen: item.lastSeen ?? null,
      recourse: {
        bonded: bond.bond > 0,
        bond: bond.bond,
        coverage_calls: bond.coverage,
        active: bond.active,
      },
    });
  }

  entries.sort((x, y) => {
    if (x.recourse.bonded !== y.recourse.bonded) return x.recourse.bonded ? -1 : 1;
    return y.settle_count - x.settle_count;
  });

  const byNetwork = new Map<string, number>();
  for (const e of entries) byNetwork.set(e.network, (byNetwork.get(e.network) ?? 0) + 1);

  const bonded = entries.filter(e => e.recourse.bonded).length;
  const view: EcosystemView = {
    fetched_at: new Date().toISOString(),
    source,
    total: entries.length,
    bonded,
    unbonded: entries.length - bonded,
    on_our_network: entries.filter(e => e.network === env.networkCaip2).length,
    registry_app_id: env.appId,
    networks: [...byNetwork.entries()]
      .map(([network, count]) => ({ network, label: label(network), count }))
      .sort((a, b) => b.count - a.count),
    entries,
    note:
      "Facts observed from the public Bazaar catalogue and the Recourse registry on chain. " +
      "Reliability is deliberately not reported for endpoints we have never bought from — " +
      "a directory listing is not evidence about anyone's uptime.",
  };

  cache = { at: Date.now(), value: view };
  return view;
}

/**
 * Pre-flight for a single endpoint: what would an agent be exposed to if it
 * paid this URL right now?
 */
export async function preflight(url: string): Promise<{
  url: string;
  found: boolean;
  entry: EcosystemEntry | null;
  verdict: string;
  recourse_available: boolean;
}> {
  const view = await ecosystem();
  const normalised = url.replace(/\/$/, "");
  const entry =
    view.entries.find(e => e.url.replace(/\/$/, "") === normalised) ??
    view.entries.find(e => e.url.startsWith(normalised)) ??
    null;

  if (!entry) {
    return {
      url,
      found: false,
      entry: null,
      recourse_available: false,
      verdict:
        "Not in the Bazaar catalogue. No bond, no published SLA, and nothing to claim against if it fails.",
    };
  }

  if (!entry.recourse.bonded) {
    return {
      url,
      found: true,
      entry,
      recourse_available: false,
      verdict:
        `Live and payable, but the recipient has no collateral posted with Recourse. ` +
        `If this response is stale or malformed, the money is gone and there is nothing to claim against.`,
    };
  }

  return {
    url,
    found: true,
    entry,
    recourse_available: true,
    verdict:
      `Bonded: ${entry.recourse.bond} ${env.assetSymbol} covering ${entry.recourse.coverage_calls} ` +
      `upheld claims. Buy /score for the full risk record before paying.`,
  };
}
