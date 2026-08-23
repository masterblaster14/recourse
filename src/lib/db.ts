/**
 * Storage for observed samples, claims and payments.
 *
 * Postgres when DATABASE_URL is set, an in-memory store otherwise. The
 * in-memory path is not a toy: it keeps the whole system runnable with zero
 * infrastructure, which matters when the alternative is a database outage
 * taking down a live demo. Both implement the same interface.
 */
import { Pool } from "pg";
import { env } from "../env.ts";

export type ProviderRow = {
  address: string;
  label: string;
  endpoint: string;
  pubkey_b64: string;
  variant: "compliant" | "stale" | "forger";
};

export type SampleRow = {
  id?: number;
  provider: string;
  ts: Date;
  http_status: number;
  latency_ms: number;
  schema_ok: boolean;
  stale_s: number;
  sig_ok: boolean;
  staleness_ok: boolean;
  latency_ok: boolean;
  /** The price the provider signed, and the moment it claimed it was from.
   *  Cross-provider consistency is computed from exactly these two fields. */
  price: number;
  claimed_ts: number;
};

export type ClaimRow = {
  id?: number;
  request_id: string;
  provider: string;
  payer: string;
  txid: string;
  refund_micro: number;
  slash_micro: number;
  age_s: number;
  ts: Date;
};

export type PaymentRow = {
  id?: number;
  provider: string;
  payer: string;
  resource: string;
  amount_micro: number;
  txid: string;
  ts: Date;
};

export type SampleAggregate = {
  samples: number;
  /** Samples where every check passed. */
  passes: number;
  /**
   * Kish effective sample size under the recency weighting.
   *
   * Recency-weighted rates and a binomial confidence interval have to be
   * computed on the same basis or they describe different things while being
   * displayed side by side. Weighted counts are not integer trials, so the
   * honest input to Wilson is the effective n — (Sum w)^2 / Sum w^2 — which
   * equals the raw count when every weight is equal and shrinks as the
   * weighting concentrates on fewer samples.
   */
  effectiveSamples: number;
  /** Recency-weighted all-checks-passed rate, on the same basis as the above. */
  weightedPassRate: number;
  recentSamples: number;
  schemaPassRate: number;
  stalenessPassRate: number;
  latencyPassRate: number;
  sigPassRate: number;
  p95LatencyMs: number;
  upheldClaims: number;
  /** Cross-provider price agreement. Undefined until there are enough peers. */
  consistency?: {
    checked: number;
    consistent: number;
    medianDivergence: number;
    conclusive: boolean;
  };
};

/**
 * Who has actually paid this provider.
 *
 * Reputation built on volume is trivially forged: a provider can pay itself all
 * day. Counting *distinct counterparties* instead is what makes the number cost
 * something, because each new counterparty is somebody the provider does not
 * control.
 *
 * Self-payments are excluded outright rather than discounted. A provider buying
 * from itself is not weak evidence of quality, it is no evidence at all, and
 * averaging it in would let a determined seller dilute its way to a reputation.
 */
export type CounterpartyStats = {
  /** Distinct payers, excluding the provider paying itself. */
  distinctPayers: number;
  /** Settled payments observed, excluding self-payments. */
  observedPayments: number;
  /** Payments where payer == provider. Counted, reported, never scored. */
  selfPayments: number;
  /** Share of observed payments from the single largest payer, 0..1. */
  topPayerShare: number;
};

export function emptyCounterparties(): CounterpartyStats {
  return { distinctPayers: 0, observedPayments: 0, selfPayments: 0, topPayerShare: 0 };
}

/** Rolls a provider's payment rows into counterparty statistics. */
export function counterpartyStats(rows: { provider: string; payer: string }[], provider: string): CounterpartyStats {
  const byPayer = new Map<string, number>();
  let selfPayments = 0;

  for (const r of rows) {
    if (r.provider !== provider) continue;
    if (r.payer === provider) { selfPayments++; continue; }
    // An unattributable settlement cannot be shown to be a distinct party, so
    // it is not allowed to look like one.
    if (!r.payer || r.payer === "unknown") continue;
    byPayer.set(r.payer, (byPayer.get(r.payer) ?? 0) + 1);
  }

  const counts = [...byPayer.values()];
  const observedPayments = counts.reduce((a, b) => a + b, 0);
  return {
    distinctPayers: byPayer.size,
    observedPayments,
    selfPayments,
    topPayerShare: observedPayments === 0 ? 0 : Math.max(...counts) / observedPayments,
  };
}

export interface Store {
  init(): Promise<void>;
  kind: "postgres" | "memory";
  upsertProvider(p: ProviderRow): Promise<void>;
  listProviders(): Promise<ProviderRow[]>;
  getProvider(address: string): Promise<ProviderRow | null>;
  insertSample(s: SampleRow): Promise<void>;
  insertClaim(c: ClaimRow): Promise<boolean>;
  insertPayment(p: PaymentRow): Promise<void>;
  aggregate(provider: string, windowHours: number): Promise<SampleAggregate>;
  /** Every provider's samples in the window. Consistency cannot be computed
   *  per provider in isolation — it is a statement about disagreement. */
  allSamples(windowHours: number): Promise<SampleRow[]>;
  recentSamples(provider: string, limit: number): Promise<SampleRow[]>;
  listClaims(limit: number): Promise<ClaimRow[]>;
  listPayments(limit: number): Promise<PaymentRow[]>;
  countPayments(): Promise<{ count: number; totalMicro: number }>;
  /** Distinct paying counterparties for one provider. See CounterpartyStats. */
  counterparties(provider: string): Promise<CounterpartyStats>;
  reset(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
  address     TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  pubkey_b64  TEXT NOT NULL,
  variant     TEXT NOT NULL DEFAULT 'compliant',
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS samples (
  id           BIGSERIAL PRIMARY KEY,
  provider     TEXT NOT NULL,
  ts           TIMESTAMPTZ DEFAULT now(),
  http_status  INT,
  latency_ms   INT,
  schema_ok    BOOLEAN,
  stale_s      INT,
  sig_ok       BOOLEAN,
  staleness_ok BOOLEAN,
  latency_ok   BOOLEAN,
  price        DOUBLE PRECISION,
  claimed_ts   BIGINT
);
ALTER TABLE samples ADD COLUMN IF NOT EXISTS price      DOUBLE PRECISION;
ALTER TABLE samples ADD COLUMN IF NOT EXISTS claimed_ts BIGINT;
CREATE INDEX IF NOT EXISTS samples_provider_ts ON samples (provider, ts DESC);

CREATE TABLE IF NOT EXISTS claims (
  id           BIGSERIAL PRIMARY KEY,
  request_id   TEXT UNIQUE,
  provider     TEXT NOT NULL,
  payer        TEXT,
  txid         TEXT,
  refund_micro BIGINT,
  slash_micro  BIGINT,
  age_s        INT,
  ts           TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id           BIGSERIAL PRIMARY KEY,
  provider     TEXT,
  payer        TEXT,
  resource     TEXT,
  amount_micro BIGINT,
  txid         TEXT,
  ts           TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_ts ON payments (ts DESC);
-- One settled transaction is one payment. A repeated txid means either a
-- bookkeeping bug or an attempt to reuse a settlement, and both should be
-- visible rather than silently doubling the recorded volume.
CREATE UNIQUE INDEX IF NOT EXISTS payments_txid_unique ON payments (txid) WHERE txid <> '';
`;

/**
 * node-postgres returns BIGINT as a *string*, and does so deliberately: an int8
 * can exceed Number.MAX_SAFE_INTEGER, and silently losing precision would be
 * worse than a type surprise. Every int8 in this schema is either a
 * micro-denominated amount or a unix timestamp, both far inside the safe range,
 * so coercing at this boundary is safe and lets the rest of the codebase work
 * in numbers.
 *
 * This is not cosmetic tidying. `computeConsistency` guards its input with
 * `typeof r.claimed_ts === "number"`, so a string claimed_ts made every sample
 * unusable — no cohort ever reached three providers, no divergence was ever
 * computed, and the cross-provider forger detector did nothing at all in
 * production while passing every test against the in-memory store, which keeps
 * numbers. A feature that is documented, tested and silently inert is worse
 * than one that is missing, so the fix belongs here at the edge rather than as
 * a defensive coercion deeper in.
 */
function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}

function toSampleRow(row: Record<string, unknown>): SampleRow {
  return {
    ...(row as unknown as SampleRow),
    ts: new Date(row.ts as string),
    http_status: num(row.http_status),
    latency_ms: num(row.latency_ms),
    stale_s: num(row.stale_s),
    price: num(row.price),
    claimed_ts: num(row.claimed_ts),
  };
}

function toClaimRow(row: Record<string, unknown>): ClaimRow {
  return {
    ...(row as unknown as ClaimRow),
    ts: new Date(row.ts as string),
    refund_micro: num(row.refund_micro),
    slash_micro: num(row.slash_micro),
    age_s: num(row.age_s),
  };
}

function toPaymentRow(row: Record<string, unknown>): PaymentRow {
  return {
    ...(row as unknown as PaymentRow),
    ts: new Date(row.ts as string),
    amount_micro: num(row.amount_micro),
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * Recency weighting: samples inside the last 6 hours count double. A provider
 * that was reliable yesterday and is failing now should score as failing now.
 */
const RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;
function weightFor(ts: Date, now: number): number {
  return now - ts.getTime() <= RECENT_WINDOW_MS ? 2 : 1;
}

function aggregateFromRows(rows: SampleRow[], upheldClaims: number): SampleAggregate {
  const now = Date.now();
  let wTotal = 0;
  let wSchema = 0;
  let wStale = 0;
  let wLatency = 0;
  let wSig = 0;
  let wPass = 0;
  let wSquared = 0;
  let recent = 0;
  let passes = 0;
  const latencies: number[] = [];

  for (const r of rows) {
    const w = weightFor(r.ts, now);
    wTotal += w;
    wSquared += w * w;
    if (r.schema_ok) wSchema += w;
    if (r.staleness_ok) wStale += w;
    if (r.latency_ok) wLatency += w;
    if (r.sig_ok) wSig += w;
    if (r.schema_ok && r.staleness_ok && r.latency_ok && r.sig_ok) {
      passes++;
      wPass += w;
    }
    if (now - r.ts.getTime() <= RECENT_WINDOW_MS) recent++;
    latencies.push(r.latency_ms);
  }

  const rate = (n: number) => (wTotal === 0 ? 0 : n / wTotal);
  const effectiveSamples = wSquared === 0 ? 0 : (wTotal * wTotal) / wSquared;
  return {
    samples: rows.length,
    passes,
    effectiveSamples,
    weightedPassRate: rate(wPass),
    recentSamples: recent,
    schemaPassRate: rate(wSchema),
    stalenessPassRate: rate(wStale),
    latencyPassRate: rate(wLatency),
    sigPassRate: rate(wSig),
    p95LatencyMs: Math.round(percentile(latencies, 95)),
    upheldClaims,
  };
}

// ------------------------------------------------------------------- memory

class MemoryStore implements Store {
  kind = "memory" as const;
  private providers = new Map<string, ProviderRow>();
  private samples: SampleRow[] = [];
  private claims: ClaimRow[] = [];
  private payments: PaymentRow[] = [];
  private nextId = 1;

  async init(): Promise<void> {}

  async upsertProvider(p: ProviderRow): Promise<void> {
    this.providers.set(p.address, p);
  }
  async listProviders(): Promise<ProviderRow[]> {
    return [...this.providers.values()];
  }
  async getProvider(address: string): Promise<ProviderRow | null> {
    return this.providers.get(address) ?? null;
  }
  async insertSample(s: SampleRow): Promise<void> {
    this.samples.push({ ...s, id: this.nextId++ });
    // Keep the working set bounded; the score only ever looks at 24h anyway.
    if (this.samples.length > 20_000) this.samples.splice(0, 5_000);
  }
  async insertClaim(c: ClaimRow): Promise<boolean> {
    if (this.claims.some(x => x.request_id === c.request_id)) return false;
    this.claims.push({ ...c, id: this.nextId++ });
    return true;
  }
  async insertPayment(p: PaymentRow): Promise<void> {
    this.payments.push({ ...p, id: this.nextId++ });
  }
  async aggregate(provider: string, windowHours: number): Promise<SampleAggregate> {
    const cutoff = Date.now() - windowHours * 3600_000;
    const rows = this.samples.filter(s => s.provider === provider && s.ts.getTime() >= cutoff);
    const upheld = this.claims.filter(c => c.provider === provider).length;
    return aggregateFromRows(rows, upheld);
  }
  async allSamples(windowHours: number): Promise<SampleRow[]> {
    const cutoff = Date.now() - windowHours * 3600_000;
    return this.samples.filter(s => s.ts.getTime() >= cutoff);
  }
  async recentSamples(provider: string, limit: number): Promise<SampleRow[]> {
    return this.samples
      .filter(s => s.provider === provider)
      .slice(-limit)
      .reverse();
  }
  async listClaims(limit: number): Promise<ClaimRow[]> {
    return [...this.claims].reverse().slice(0, limit);
  }
  async listPayments(limit: number): Promise<PaymentRow[]> {
    return [...this.payments].reverse().slice(0, limit);
  }
  async countPayments(): Promise<{ count: number; totalMicro: number }> {
    return {
      count: this.payments.length,
      totalMicro: this.payments.reduce((a, p) => a + p.amount_micro, 0),
    };
  }
  async counterparties(provider: string): Promise<CounterpartyStats> {
    return counterpartyStats(this.payments, provider);
  }
  async reset(): Promise<void> {
    this.samples = [];
    this.claims = [];
    this.payments = [];
  }
}

// ----------------------------------------------------------------- postgres

class PostgresStore implements Store {
  kind = "postgres" as const;
  private pool: Pool;

  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url,
      // Railway and most managed Postgres present a cert we do not pin.
      ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false },
      max: 5,
    });
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async upsertProvider(p: ProviderRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO providers (address, label, endpoint, pubkey_b64, variant)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (address) DO UPDATE
         SET label=$2, endpoint=$3, pubkey_b64=$4, variant=$5`,
      [p.address, p.label, p.endpoint, p.pubkey_b64, p.variant],
    );
  }

  async listProviders(): Promise<ProviderRow[]> {
    const r = await this.pool.query("SELECT * FROM providers ORDER BY label");
    return r.rows as ProviderRow[];
  }

  async getProvider(address: string): Promise<ProviderRow | null> {
    const r = await this.pool.query("SELECT * FROM providers WHERE address=$1", [address]);
    return (r.rows[0] as ProviderRow) ?? null;
  }

  async insertSample(s: SampleRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO samples
         (provider, ts, http_status, latency_ms, schema_ok, stale_s, sig_ok, staleness_ok, latency_ok, price, claimed_ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        s.provider, s.ts, s.http_status, s.latency_ms,
        s.schema_ok, s.stale_s, s.sig_ok, s.staleness_ok, s.latency_ok,
        s.price, s.claimed_ts,
      ],
    );
  }

  async insertClaim(c: ClaimRow): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO claims (request_id, provider, payer, txid, refund_micro, slash_micro, age_s, ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (request_id) DO NOTHING`,
      [c.request_id, c.provider, c.payer, c.txid, c.refund_micro, c.slash_micro, c.age_s, c.ts],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async insertPayment(p: PaymentRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO payments (provider, payer, resource, amount_micro, txid, ts)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (txid) WHERE txid <> '' DO NOTHING`,
      [p.provider, p.payer, p.resource, p.amount_micro, p.txid, p.ts],
    );
  }

  async aggregate(provider: string, windowHours: number): Promise<SampleAggregate> {
    const r = await this.pool.query(
      `SELECT provider, ts, http_status, latency_ms, schema_ok, stale_s, sig_ok, staleness_ok, latency_ok
         FROM samples
        WHERE provider=$1 AND ts >= now() - ($2 || ' hours')::interval`,
      [provider, String(windowHours)],
    );
    const c = await this.pool.query(
      "SELECT count(*)::int AS n FROM claims WHERE provider=$1",
      [provider],
    );
    const rows = r.rows.map(toSampleRow);
    return aggregateFromRows(rows, c.rows[0]?.n ?? 0);
  }

  async allSamples(windowHours: number): Promise<SampleRow[]> {
    const r = await this.pool.query(
      `SELECT * FROM samples WHERE ts >= now() - ($1 || ' hours')::interval`,
      [String(windowHours)],
    );
    return r.rows.map(toSampleRow);
  }

  async recentSamples(provider: string, limit: number): Promise<SampleRow[]> {
    const r = await this.pool.query(
      "SELECT * FROM samples WHERE provider=$1 ORDER BY ts DESC LIMIT $2",
      [provider, limit],
    );
    return r.rows.map(toSampleRow);
  }

  async listClaims(limit: number): Promise<ClaimRow[]> {
    const r = await this.pool.query("SELECT * FROM claims ORDER BY ts DESC LIMIT $1", [limit]);
    return r.rows.map(toClaimRow);
  }

  async listPayments(limit: number): Promise<PaymentRow[]> {
    const r = await this.pool.query("SELECT * FROM payments ORDER BY ts DESC LIMIT $1", [limit]);
    return r.rows.map(toPaymentRow);
  }

  async countPayments(): Promise<{ count: number; totalMicro: number }> {
    const r = await this.pool.query(
      "SELECT count(*)::int AS n, COALESCE(sum(amount_micro),0)::bigint AS total FROM payments",
    );
    return { count: r.rows[0]?.n ?? 0, totalMicro: Number(r.rows[0]?.total ?? 0) };
  }

  async counterparties(provider: string): Promise<CounterpartyStats> {
    // Grouped in the database rather than pulled into memory: the payments
    // table grows with every settled call, including strangers' calls.
    const r = await this.pool.query(
      `SELECT payer, count(*)::int AS n
         FROM payments
        WHERE provider = $1
          AND payer IS NOT NULL AND payer <> '' AND payer <> 'unknown'
          AND payer <> provider
        GROUP BY payer`,
      [provider],
    );
    const self = await this.pool.query(
      "SELECT count(*)::int AS n FROM payments WHERE provider = $1 AND payer = provider",
      [provider],
    );
    const counts = (r.rows as { n: number }[]).map(x => x.n);
    const observedPayments = counts.reduce((a, b) => a + b, 0);
    return {
      distinctPayers: counts.length,
      observedPayments,
      selfPayments: self.rows[0]?.n ?? 0,
      topPayerShare: observedPayments === 0 ? 0 : Math.max(...counts) / observedPayments,
    };
  }

  async reset(): Promise<void> {
    await this.pool.query("TRUNCATE samples, claims, payments");
  }
}

let _store: Store | null = null;

export function store(): Store {
  if (!_store) {
    _store = env.databaseUrl ? new PostgresStore(env.databaseUrl) : new MemoryStore();
  }
  return _store;
}

export async function initStore(): Promise<Store> {
  const s = store();
  try {
    await s.init();
  } catch (err) {
    console.error(`[db] init failed (${s.kind}):`, (err as Error).message);
    if (s.kind === "postgres") {
      console.error("[db] falling back to in-memory store so the service stays up");
      _store = new MemoryStore();
      await _store.init();
    }
  }
  return _store!;
}
