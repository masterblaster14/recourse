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
  variant: "compliant" | "stale";
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
  /** Samples where every check passed. The basis for the confidence interval. */
  passes: number;
  recentSamples: number;
  schemaPassRate: number;
  stalenessPassRate: number;
  latencyPassRate: number;
  sigPassRate: number;
  p95LatencyMs: number;
  upheldClaims: number;
};

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
  recentSamples(provider: string, limit: number): Promise<SampleRow[]>;
  listClaims(limit: number): Promise<ClaimRow[]>;
  listPayments(limit: number): Promise<PaymentRow[]>;
  countPayments(): Promise<{ count: number; totalMicro: number }>;
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
  latency_ok   BOOLEAN
);
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
`;

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
  let recent = 0;
  let passes = 0;
  const latencies: number[] = [];

  for (const r of rows) {
    const w = weightFor(r.ts, now);
    wTotal += w;
    if (r.schema_ok) wSchema += w;
    if (r.staleness_ok) wStale += w;
    if (r.latency_ok) wLatency += w;
    if (r.sig_ok) wSig += w;
    if (r.schema_ok && r.staleness_ok && r.latency_ok && r.sig_ok) passes++;
    if (now - r.ts.getTime() <= RECENT_WINDOW_MS) recent++;
    latencies.push(r.latency_ms);
  }

  const rate = (n: number) => (wTotal === 0 ? 0 : n / wTotal);
  return {
    samples: rows.length,
    passes,
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
         (provider, ts, http_status, latency_ms, schema_ok, stale_s, sig_ok, staleness_ok, latency_ok)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        s.provider, s.ts, s.http_status, s.latency_ms,
        s.schema_ok, s.stale_s, s.sig_ok, s.staleness_ok, s.latency_ok,
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
       VALUES ($1,$2,$3,$4,$5,$6)`,
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
    const rows = (r.rows as SampleRow[]).map(row => ({ ...row, ts: new Date(row.ts) }));
    return aggregateFromRows(rows, c.rows[0]?.n ?? 0);
  }

  async recentSamples(provider: string, limit: number): Promise<SampleRow[]> {
    const r = await this.pool.query(
      "SELECT * FROM samples WHERE provider=$1 ORDER BY ts DESC LIMIT $2",
      [provider, limit],
    );
    return (r.rows as SampleRow[]).map(row => ({ ...row, ts: new Date(row.ts) }));
  }

  async listClaims(limit: number): Promise<ClaimRow[]> {
    const r = await this.pool.query("SELECT * FROM claims ORDER BY ts DESC LIMIT $1", [limit]);
    return (r.rows as ClaimRow[]).map(row => ({ ...row, ts: new Date(row.ts) }));
  }

  async listPayments(limit: number): Promise<PaymentRow[]> {
    const r = await this.pool.query("SELECT * FROM payments ORDER BY ts DESC LIMIT $1", [limit]);
    return (r.rows as PaymentRow[]).map(row => ({ ...row, ts: new Date(row.ts) }));
  }

  async countPayments(): Promise<{ count: number; totalMicro: number }> {
    const r = await this.pool.query(
      "SELECT count(*)::int AS n, COALESCE(sum(amount_micro),0)::bigint AS total FROM payments",
    );
    return { count: r.rows[0]?.n ?? 0, totalMicro: Number(r.rows[0]?.total ?? 0) };
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
