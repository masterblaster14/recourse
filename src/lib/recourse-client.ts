/**
 * The Recourse client library — what an agent actually integrates.
 *
 *   score()   pay for a provider's reliability record before buying from it
 *   buy()     pay for the resource over x402
 *   verify()  run the six checks against the provider's published SLA
 *   claim()   when a check proves a violation, settle it out of the bond
 *   select()  decide who to buy from next
 *
 * `select` is the part that matters. Everything else exists so that this
 * function has something honest to decide on.
 */
import algosdk from "algosdk";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { env, x402SecretKeyFromMnemonic } from "../env.ts";
import { decodePaymentRequired } from "../x402.ts";
import { claimMessage, ed25519Verify, responseHash } from "./signing.ts";
import { submitClaim } from "./chain.ts";
import type { ScoreRecord } from "./scoring.ts";
import type { CheckResult, RouteCandidate } from "./bus.ts";

/**
 * What the agent insists a 402 must say before it will build a payment.
 *
 * The important one is `payTo`. An agent that looks up a provider's collateral
 * and then pays whatever address the 402 happens to name is trusting the
 * endpoint, not the registry: a compromised or malicious host could swap in an
 * attacker's address and collect real money while the bonded provider's
 * reputation vouches for it — and nothing would be claimable afterwards,
 * because the bonded provider never signed anything.
 */
export type PaymentExpectation = {
  /** The address whose bond was actually checked. */
  payTo?: string;
  assetId?: number;
  networkCaip2?: string;
  maxAmountMicro?: number;
};

export class PaymentRefused extends Error {
  constructor(readonly detail: string) {
    super(`refused to pay: ${detail}`);
    this.name = "PaymentRefused";
  }
}

/**
 * Checks a 402 against what the agent decided to buy. Throws rather than
 * returning false, so the refusal aborts before a transaction is constructed.
 */
export function assertPaymentAcceptable(
  header: string | null,
  expect: PaymentExpectation,
): void {
  const required = decodePaymentRequired(header);
  if (!required || required.accepts.length === 0) {
    throw new PaymentRefused("402 carried no readable payment requirements");
  }

  // Any advertised option that satisfies every expectation is enough.
  const reasons: string[] = [];
  for (const a of required.accepts) {
    if (expect.payTo && a.payTo !== expect.payTo) {
      reasons.push(`payee is ${a.payTo.slice(0, 10)}… but the bond checked was ${expect.payTo.slice(0, 10)}…`);
      continue;
    }
    if (expect.assetId !== undefined && a.asset !== String(expect.assetId)) {
      reasons.push(`asset ${a.asset} is not ${expect.assetId}`);
      continue;
    }
    if (expect.networkCaip2 && a.network !== expect.networkCaip2) {
      reasons.push(`network ${a.network} is not ${expect.networkCaip2}`);
      continue;
    }
    if (expect.maxAmountMicro !== undefined && Number(a.amount) > expect.maxAmountMicro) {
      reasons.push(`price ${a.amount} exceeds the cap of ${expect.maxAmountMicro}`);
      continue;
    }
    return; // acceptable
  }
  throw new PaymentRefused(reasons[0] ?? "no advertised option was acceptable");
}

export type SignedResponse = {
  symbol: string;
  price: number;
  data_timestamp: number;
  request_id: string;
  response_hash: string;
  signature: string;
  provider: string;
  sla_hash?: string;
};

export type VerifyOutcome = {
  pass: boolean;
  /**
   * Whether this outcome says anything about the provider at all. False when
   * the payment layer failed, in which case the sample must be discarded
   * rather than counted against the provider's reliability.
   */
  attributable: boolean;
  checks: CheckResult[];
  /** True only when the provider's own signature proves an SLA breach. */
  provableViolation: boolean;
  latencyMs: number;
  staleS: number;
  schemaOk: boolean;
  latencyOk: boolean;
  stalenessOk: boolean;
  sigOk: boolean;
};

export type BuyResult = {
  ok: boolean;
  status: number;
  /** Time to complete the paid request. Includes on-chain settlement — the
   *  x402 resource server settles before it returns the resource. */
  latencyMs: number;
  /** Whole exchange: the unpaid 402 probe plus the paid request. */
  totalMs: number;
  /** True when the agent refused to pay at all — the 402 asked for something
   *  other than what was expected, so no transaction was ever built. */
  refused: boolean;
  body: SignedResponse | null;
  settlement: { transaction: string; payer?: string; success: boolean } | null;
  /**
   * True when the x402 exchange itself never completed — the client could not
   * build a payment, or the facilitator failed to settle. The provider never
   * got the chance to answer, so nothing here is attributable to it.
   */
  paymentFailed: boolean;
  error?: string;
};

const REQUIRED_FIELDS = ["symbol", "price", "data_timestamp"] as const;

/**
 * How many calls the agent will make to an unmeasured provider before it starts
 * trusting the score. This is the number that makes a bond worth posting: a
 * brand new provider gets real traffic because the bond, not a reputation it
 * cannot have yet, is what protects the buyer.
 */
export const EXPLORE_SAMPLES = 6;

/**
 * How much latitude an unmeasured provider actually gets.
 *
 * Flat exploration is a free lunch for an attacker: register, harvest the
 * allowance serving junk, abandon, register again. Scaling the allowance to
 * what the bond can actually cover makes the cold start something the provider
 * has paid for — a thin bond buys proportionally less rope.
 */
export function exploreAllowance(coverageCalls: number): number {
  return Math.max(1, Math.min(EXPLORE_SAMPLES, coverageCalls));
}

/**
 * The assets this agent will spend, with a hard per-payment ceiling.
 *
 * Entries are matched against the network string the resource server actually
 * advertises, as a literal-or-glob pattern. We list the exact network first and
 * fall back to a wildcard, because servers advertise Algorand either as the full
 * genesis hash or as the 32-character canonical form and only an exact string
 * (or a glob) matches.
 */
function assetAllowList() {
  const cap = String(maxPaymentMicro());
  const asset = String(env.assetId);
  return [
    { network: env.networkCaip2, asset, maxAmountPerPayment: cap },
    { network: "algorand:*" as `${string}:${string}`, asset, maxAmountPerPayment: cap },
  ];
}

/** Five times the advertised price. Generous enough to absorb a price change,
 *  tight enough that a hostile 402 cannot drain the wallet on one call. */
export function maxPaymentMicro(): number {
  return Math.max(env.priceMicro, env.scorePriceMicro) * 5;
}

export class RecourseClient {
  readonly address: string;
  private readonly account: algosdk.Account;
  private readonly httpClient: x402HTTPClient;
  private readonly client: x402Client;

  constructor(mnemonic: string) {
    this.account = algosdk.mnemonicToSecretKey(mnemonic);
    this.address = this.account.addr.toString();

    const signer = toClientAvmSigner(x402SecretKeyFromMnemonic(mnemonic));
    if (signer.address !== this.address) {
      throw new Error(
        `x402 signer address ${signer.address} does not match account ${this.address}`,
      );
    }
    const client = new x402Client()
      .register("algorand:*", new ExactAvmScheme(signer))
      // An unattended buyer should never hand a server an open cheque. The cap
      // is the most this agent will pay for any single call, whatever the 402
      // asks for. It also opts in the bond asset explicitly: the x402 client
      // refuses non-default tokens unless you say so, which is the right
      // default and exactly the kind of guard rail Recourse argues for.
      .setSpendControls({
        maxAmountPerPayment: "$1",
        allowedAssets: assetAllowList(),
      });
    this.httpClient = new x402HTTPClient(client);
    this.client = client;
  }

  /**
   * Pay for and fetch any x402 resource.
   *
   * Two timings are recorded because an x402 exchange is two HTTP requests: an
   * unpaid probe that returns 402, then the paid request. `latencyMs` is the
   * paid leg alone, `totalMs` is both.
   *
   * Note what `latencyMs` unavoidably contains: an x402 resource server settles
   * the payment on chain *before* it returns the resource, so a few seconds of
   * Algorand finality are inside the number and no client-side measurement can
   * separate them. That is precisely why a latency breach is observed in the
   * score but is never claimable — it is not attributable to the provider.
   */
  async pay(url: string, expect: PaymentExpectation = {}): Promise<BuyResult> {
    const started = Date.now();
    const legs: number[] = [];
    let refused = false;

    const timedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const t0 = Date.now();
      const res = await fetch(input as RequestInfo, init);
      legs.push(Date.now() - t0);

      // Inspect the challenge before a payment is built. Reading a header does
      // not consume the body, so the wrapper still sees an intact response.
      if (res.status === 402) {
        try {
          assertPaymentAcceptable(res.headers.get("PAYMENT-REQUIRED"), expect);
        } catch (err) {
          refused = true;
          throw err;
        }
      }
      return res;
    }) as typeof fetch;

    try {
      const payFetch = wrapFetchWithPayment(timedFetch, this.client) as typeof fetch;
      const res = await payFetch(url, { method: "GET" });
      const totalMs = Date.now() - started;
      // Last leg is the paid request; the first was the unpaid 402 probe.
      const latencyMs = legs.length > 0 ? legs[legs.length - 1] : totalMs;
      const body = res.ok ? ((await res.json()) as SignedResponse) : null;

      let settlement: BuyResult["settlement"] = null;
      if (res.ok) {
        try {
          const settle = this.httpClient.getPaymentSettleResponse(name =>
            res.headers.get(name),
          );
          if (settle?.transaction) {
            settlement = {
              transaction: settle.transaction,
              payer: settle.payer,
              success: settle.success !== false,
            };
          }
        } catch {
          // A missing settlement header is not fatal; the response still stands.
        }
      }

      return {
        ok: res.ok, status: res.status, latencyMs, totalMs, body, settlement, refused,
        // A 402 that came back a second time means payment did not take.
        paymentFailed: !res.ok && res.status === 402,
      };
    } catch (err) {
      const totalMs = Date.now() - started;
      return {
        ok: false,
        status: 0,
        latencyMs: legs.length > 0 ? legs[legs.length - 1] : totalMs,
        totalMs,
        body: null,
        settlement: null,
        refused,
        // wrapFetchWithPayment throws only on the payment path: it could not
        // create a payload, or settlement failed. A refusal is our own doing,
        // so it is not a payment-layer failure.
        paymentFailed: !refused,
        error: String((err as Error)?.message ?? err),
      };
    }
  }

  /**
   * Buy a provider's risk record over x402.
   *
   * Worth paying for because of what it contains that the agent cannot derive
   * itself. Bond and active status are on chain and free to read. The observed
   * reliability — pass rates and latency distribution aggregated across every
   * buyer — is not, and no single agent can compute it from its own traffic.
   * That aggregate is the product.
   */
  async score(
    baseUrl: string,
    provider: string,
  ): Promise<{ record: ScoreRecord | null; receipt: BuyResult }> {
    const receipt = await this.pay(`${baseUrl}/score?provider=${provider}`);
    return {
      record: receipt.ok ? (receipt.body as unknown as ScoreRecord) : null,
      receipt,
    };
  }

  async buy(endpoint: string, expect: PaymentExpectation = {}): Promise<BuyResult> {
    return this.pay(endpoint, expect);
  }

  /**
   * The six checks, in order, against the SLA the provider committed on chain.
   *
   * The distinction that matters is between check 4 and check 6. Stale data the
   * provider signed is provable and claimable. A missing or bad signature is
   * only observable — we mark it down but cannot slash for it, and saying so
   * plainly is the honest position.
   */
  verify(
    result: BuyResult,
    sla: { max_staleness_s: number; max_latency_ms: number },
    pubkey: Buffer,
  ): VerifyOutcome {
    const checks: CheckResult[] = [];
    const body = result.body;

    const statusOk = result.ok && result.status === 200;
    checks.push({
      name: "http_200",
      pass: statusOk,
      detail: statusOk ? "200 OK" : `status ${result.status}${result.error ? ` — ${result.error}` : ""}`,
    });

    const missing = body
      ? REQUIRED_FIELDS.filter(f => (body as Record<string, unknown>)[f] === undefined)
      : [...REQUIRED_FIELDS];
    const schemaOk = statusOk && missing.length === 0;
    checks.push({
      name: "required_fields",
      pass: schemaOk,
      detail: schemaOk ? "all present" : `missing ${missing.join(", ")}`,
    });

    const latencyOk = result.latencyMs <= sla.max_latency_ms;
    checks.push({
      name: "latency",
      pass: latencyOk,
      detail: `${result.latencyMs}ms vs ${sla.max_latency_ms}ms`,
    });

    const nowS = Math.floor(Date.now() / 1000);
    const staleS = body ? nowS - body.data_timestamp : Number.MAX_SAFE_INTEGER;
    const stalenessOk = schemaOk && staleS <= sla.max_staleness_s;
    checks.push({
      name: "staleness",
      pass: stalenessOk,
      detail: body ? `${staleS}s old vs ${sla.max_staleness_s}s allowed` : "no data",
    });

    let hashOk = false;
    if (body) {
      const expected = responseHash({
        symbol: body.symbol,
        price: body.price,
        data_timestamp: body.data_timestamp,
      }).toString("hex");
      hashOk = expected === body.response_hash;
    }
    checks.push({
      name: "response_hash",
      pass: hashOk,
      detail: hashOk ? "sha256 matches canonical payload" : "hash mismatch",
    });

    let sigOk = false;
    if (body && hashOk && body.signature && body.request_id) {
      try {
        sigOk = ed25519Verify(
          claimMessage(
            Buffer.from(body.request_id, "hex"),
            Buffer.from(body.response_hash, "hex"),
            body.data_timestamp,
          ),
          Buffer.from(body.signature, "base64"),
          pubkey,
        );
      } catch {
        sigOk = false;
      }
    }
    checks.push({
      name: "signature",
      pass: sigOk,
      detail: sigOk ? "ed25519 verified against on-chain pubkey" : "signature missing or invalid",
    });

    const pass = checks.every(c => c.pass);
    return {
      pass,
      attributable: !result.paymentFailed,
      checks,
      // Signed, and the signed timestamp breaches the provider's own bound.
      provableViolation: sigOk && !stalenessOk && schemaOk,
      latencyMs: result.latencyMs,
      staleS: body ? staleS : -1,
      schemaOk,
      latencyOk,
      stalenessOk,
      sigOk,
    };
  }

  /** Settle a proven violation out of the provider's bond. */
  async claim(opts: {
    appId: number;
    assetId: number;
    provider: string;
    treasury: string;
    body: SignedResponse;
  }): Promise<{ txid: string; refundMicro: number; groupTxIds: string[] }> {
    return submitClaim(this.account, {
      appId: opts.appId,
      assetId: opts.assetId,
      provider: opts.provider,
      treasury: opts.treasury,
      requestId: Buffer.from(opts.body.request_id, "hex"),
      responseHash: Buffer.from(opts.body.response_hash, "hex"),
      dataTimestamp: opts.body.data_timestamp,
      signature: Buffer.from(opts.body.signature, "base64"),
    });
  }
}

// ------------------------------------------------------------------- routing

export type Selection = {
  chosen: ScoreRecord | null;
  reason: string;
  candidates: RouteCandidate[];
};

/**
 * The routing decision.
 *
 * A provider is eligible only if it is still bonded. Below the exploration
 * threshold the score is treated as unknown rather than bad, so a new provider
 * can earn its first customers — the bond is what makes that safe. Once there
 * is enough evidence, the score governs and an `avoid` verdict is final.
 */
export function selectProvider(scores: ScoreRecord[]): Selection {
  const candidates: RouteCandidate[] = scores.map(s => {
    const bonded = s.active && s.coverage_calls >= 1;
    const allowance = exploreAllowance(s.coverage_calls);
    const exploring = s.observed.samples < allowance;
    let eligible: boolean;
    let reason: string;

    if (!bonded) {
      eligible = false;
      reason = s.active ? "bond cannot cover a single claim" : "bond exhausted, deactivated on chain";
    } else if (exploring) {
      eligible = true;
      reason = `unmeasured (${s.observed.samples}/${allowance}), covered by ${s.coverage_calls} claims of bond`;
    } else if (s.recommendation === "unrated") {
      // No evidence against it, and the bond is what covers the risk meanwhile.
      eligible = true;
      reason = `${s.observed.passes}/${s.observed.samples} clean but not yet conclusive — bond covers ${s.coverage_calls} claims`;
    } else if (s.recommendation === "avoid") {
      eligible = false;
      reason = `${s.observed.passes}/${s.observed.samples} clean, ≥${(s.reliability_lower_bound * 100).toFixed(0)}% at 95% — avoid`;
    } else {
      eligible = true;
      reason = `${s.observed.passes}/${s.observed.samples} clean, ≥${(s.reliability_lower_bound * 100).toFixed(0)}% at 95% — ${s.recommendation}`;
    }

    return {
      provider: s.provider,
      label: s.label,
      reliability: s.reliability,
      recommendation: s.recommendation,
      confidence: s.confidence,
      bondMicro: s.bond_micro,
      coverageCalls: s.coverage_calls,
      active: s.active,
      eligible,
      reason,
    };
  });

  const eligible = scores.filter(s => candidates.find(c => c.provider === s.provider)?.eligible);

  if (eligible.length === 0) {
    return {
      chosen: null,
      reason: "no provider is both bonded and trusted — the agent stops buying",
      candidates,
    };
  }

  // Explore the least-measured provider first, so evidence accumulates evenly
  // instead of the first provider tried monopolising the traffic.
  const unmeasured = eligible.filter(
    s => s.observed.samples < exploreAllowance(s.coverage_calls),
  );
  if (unmeasured.length > 0) {
    const chosen = unmeasured.reduce((a, b) =>
      a.observed.samples <= b.observed.samples ? a : b,
    );
    return {
      chosen,
      reason: `exploring — ${chosen.observed.samples}/${exploreAllowance(chosen.coverage_calls)} samples, bond covers ${chosen.coverage_calls} claims`,
      candidates,
    };
  }

  // Rank on the lower bound, not the point estimate: between two providers that
  // both show 100%, prefer the one with more evidence behind it.
  const chosen = eligible.reduce((a, b) => {
    if (b.reliability_lower_bound !== a.reliability_lower_bound) {
      return b.reliability_lower_bound > a.reliability_lower_bound ? b : a;
    }
    return b.coverage_calls > a.coverage_calls ? b : a;
  });
  return {
    chosen,
    reason: `best of ${eligible.length} eligible — ≥${(chosen.reliability_lower_bound * 100).toFixed(0)}% at 95%, ${chosen.coverage_calls} claims covered`,
    candidates,
  };
}

export function agentClient(): RecourseClient {
  if (!env.agentMnemonic) throw new Error("AGENT_MNEMONIC is not set");
  return new RecourseClient(env.agentMnemonic);
}
