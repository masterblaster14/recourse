/**
 * The buying agent.
 *
 * This is an actual x402 client paying actual TestNet money to the resource
 * server, over the GoPlausible facilitator, one call at a time. Nothing here is
 * simulated. Every step publishes to the event bus so the dashboard can show
 * the decision being made rather than reporting it afterwards.
 *
 * The loop:
 *   1. read the score for every candidate         (on chain + observed)
 *   2. decide who to buy from                     <- the pitch
 *   3. pay over x402                              (real settlement)
 *   4. run the six checks against the SLA
 *   5. if the provider signed an SLA breach, claim it out of its bond
 *   6. repeat, with the score now different
 */
import { randomUUID } from "node:crypto";
import algosdk from "algosdk";
import { env, fromMicro } from "../env.ts";
import { log, now, publish, type DemoSummary } from "../lib/bus.ts";
import { recordSuccess } from "../lib/chain.ts";
import { store } from "../lib/db.ts";
import { record } from "../lib/proof.ts";
import {
  providerByAddress,
  providers,
  slaFor,
  type DemoProvider,
} from "../lib/providers.ts";
import { slaHash } from "../lib/signing.ts";
import { agentClient, selectProvider, type RecourseClient } from "../lib/recourse-client.ts";
import { allScores, invalidateScore, scoreFor } from "../lib/service.ts";

export type DemoOptions = {
  calls?: number;
  baseUrl?: string;
  pauseMs?: number;
  scoreFirst?: boolean;
};

let running = false;
export function isRunning(): boolean {
  return running;
}

/**
 * Resolve the signing key the way an outside agent would: read the SLA the
 * provider publishes, then check its hash against the sla_hash committed on
 * chain. If they disagree the API is serving a different SLA than the one the
 * provider staked against, and nothing it says can be trusted.
 */
async function trustedPubkey(
  baseUrl: string,
  provider: string,
  onchainSlaHash: string,
): Promise<{ pubkey: Buffer; slaVerified: boolean; sla: { max_staleness_s: number; max_latency_ms: number } }> {
  const local = providerByAddress(provider);
  const fallback = local ? slaFor(local) : null;

  try {
    const res = await fetch(`${baseUrl}/sla?provider=${provider}`);
    if (res.ok) {
      const doc = (await res.json()) as { sla: ReturnType<typeof slaFor> };
      const computed = `0x${slaHash(doc.sla).toString("hex")}`;
      const verified = computed.toLowerCase() === onchainSlaHash.toLowerCase();
      if (!verified) {
        log("warn", `SLA hash mismatch for ${provider.slice(0, 8)} — published doc does not match the on-chain commitment`);
      }
      return {
        pubkey: Buffer.from(doc.sla.signing.pubkey_b64, "base64"),
        slaVerified: verified,
        sla: { max_staleness_s: doc.sla.max_staleness_s, max_latency_ms: doc.sla.max_latency_ms },
      };
    }
  } catch {
    // fall through to local knowledge
  }

  return {
    pubkey: local?.pubkey ?? Buffer.alloc(32),
    slaVerified: false,
    sla: {
      max_staleness_s: fallback?.max_staleness_s ?? env.maxStalenessS,
      max_latency_ms: fallback?.max_latency_ms ?? env.maxLatencyMs,
    },
  };
}

/**
 * Buy /score for every candidate over x402.
 *
 * Deliberately not on every call. Bond and active status are on chain and free
 * to read, and the agent already knows how its own calls went — so what it is
 * actually buying here is the aggregate observation across all buyers, which it
 * cannot compute alone. An agent surveys the market when it starts and when
 * something changes its mind, not once per request.
 */
async function marketSurvey(
  client: RecourseClient,
  baseUrl: string,
  runId: string,
  index: number,
  why: string,
): Promise<void> {
  for (const p of providers()) {
    if (!p.address) continue;
    const { record, receipt } = await client.score(baseUrl, p.address);
    const txid = receipt.settlement?.transaction ?? null;
    if (txid) record_x402(txid, `agent bought /score for ${p.label} — ${why}`);
    publish({
      type: "pay", at: now(), runId, index,
      provider: env.treasuryAddress, label: `Recourse /score — ${p.label}`,
      resource: `${baseUrl}/score?provider=${p.address}`,
      amountMicro: env.scorePriceMicro, txid, settled: Boolean(txid),
    });
    if (record) {
      publish({
        type: "score", at: now(), provider: record.provider, label: record.label,
        reliability: record.reliability, recommendation: record.recommendation,
        confidence: record.confidence, bondMicro: record.bond_micro,
        coverageCalls: record.coverage_calls,
      });
    }
  }
  log("info", `paid market survey (${why}) — ${providers().length} x /score purchased over x402`);
}

const record_x402 = (txid: string, note: string) => record("x402_payment", txid, note);

export async function runDemo(opts: DemoOptions = {}): Promise<DemoSummary> {
  if (running) throw new Error("a demo run is already in progress");
  running = true;

  const runId = randomUUID().slice(0, 8);
  const calls = opts.calls ?? 30;
  const baseUrl = (opts.baseUrl ?? env.publicUrl).replace(/\/$/, "");
  const pauseMs = opts.pauseMs ?? 0;

  const summary: DemoSummary = {
    calls: 0,
    paid: 0,
    passed: 0,
    failed: 0,
    claims: 0,
    refundedMicro: 0,
    slashedMicro: 0,
    spentMicro: 0,
    routingSwitchedAt: null,
    byProvider: {},
  };

  const client: RecourseClient = agentClient();
  const successBuffer = new Map<string, number>();
  let lastChosen: string | null = null;

  publish({ type: "demo:start", runId, calls, at: now() });
  log("info", `agent ${client.address.slice(0, 8)}… starting ${calls} x402 calls against ${baseUrl}`);

  try {
    // Before spending anything on data, buy the risk record for each candidate.
    await marketSurvey(client, baseUrl, runId, 0, "opening survey");

    for (let i = 1; i <= calls; i++) {
      summary.calls = i;

      // ---- 1. what does the market look like right now
      invalidateScore();
      const scores = await allScores({ fresh: true });
      if (scores.length === 0) {
        log("error", "no providers registered on chain — run `npm run setup` first");
        break;
      }
      for (const s of scores) {
        publish({
          type: "score", at: now(), provider: s.provider, label: s.label,
          reliability: s.reliability, recommendation: s.recommendation,
          confidence: s.confidence, bondMicro: s.bond_micro, coverageCalls: s.coverage_calls,
        });
      }

      // ---- 2. the routing decision
      const selection = selectProvider(scores);
      publish({
        type: "route", at: now(), runId, index: i,
        chosen: selection.chosen?.provider ?? "",
        chosenLabel: selection.chosen?.label ?? "none",
        reason: selection.reason,
        candidates: selection.candidates,
      });

      if (!selection.chosen) {
        log("warn", `call ${i}: ${selection.reason}`);
        break;
      }
      if (lastChosen && lastChosen !== selection.chosen.provider && summary.routingSwitchedAt === null) {
        // Only interesting once the agent has stopped alternating.
        const stoppedUsing = selection.candidates.find(c => !c.eligible);
        if (stoppedUsing) {
          summary.routingSwitchedAt = i;
          log("info", `call ${i}: routing switched — ${stoppedUsing.label} is out (${stoppedUsing.reason})`);
          // The market changed, so re-survey it — this is exactly the moment an
          // agent has a reason to pay for a fresh risk record.
          await marketSurvey(client, baseUrl, runId, i, "after routing switch");
        }
      }
      lastChosen = selection.chosen.provider;

      const chosen = selection.chosen;
      const provider: DemoProvider | undefined = providerByAddress(chosen.provider);
      const endpoint = provider?.endpoint ?? chosen.endpoint;
      const bucket = (summary.byProvider[chosen.provider] ??= {
        label: chosen.label, calls: 0, passed: 0, failed: 0,
      });
      bucket.calls++;

      // ---- 3. pay for it over x402
      const result = await client.buy(endpoint);
      const settledTx = result.settlement?.transaction ?? null;
      if (result.ok) {
        summary.paid++;
        if (settledTx) record("x402_payment", settledTx, `agent paid ${chosen.label} over x402 via the GoPlausible facilitator`);
        summary.spentMicro += chosen.price_micro;
        // The paywall middleware already books every settled payment, including
        // ones made by agents that are not us. Recording here too would double
        // count our own traffic.
      }
      publish({
        type: "pay", at: now(), runId, index: i,
        provider: chosen.provider, label: chosen.label,
        resource: endpoint, amountMicro: chosen.price_micro,
        txid: settledTx, settled: Boolean(settledTx),
      });

      // ---- 4. verify against the SLA the provider committed to on chain
      const { pubkey, sla } = await trustedPubkey(baseUrl, chosen.provider, chosen.sla.sla_hash);
      const outcome = client.verify(result, sla, pubkey);

      if (outcome.attributable) {
        await store().insertSample({
          provider: chosen.provider,
          ts: new Date(),
          http_status: result.status,
          latency_ms: result.latencyMs,
          schema_ok: outcome.schemaOk,
          stale_s: outcome.staleS,
          sig_ok: outcome.sigOk,
          staleness_ok: outcome.stalenessOk,
          latency_ok: outcome.latencyOk,
          price: result.body?.price ?? 0,
          claimed_ts: result.body?.data_timestamp ?? 0,
        });
      } else {
        // The payment layer failed, so the provider never had a turn. Counting
        // this would let a facilitator outage tank every provider's score at
        // once for something none of them did.
        log("warn", `call ${i}: x402 exchange failed (${result.error ?? "no settlement"}) — sample discarded, not charged to ${chosen.label}`);
      }

      if (outcome.pass) {
        summary.passed++;
        bucket.passed++;
        successBuffer.set(chosen.provider, (successBuffer.get(chosen.provider) ?? 0) + 1);
      } else {
        summary.failed++;
        bucket.failed++;
      }

      publish({
        type: "verify", at: now(), runId, index: i,
        provider: chosen.provider, label: chosen.label,
        pass: outcome.pass, checks: outcome.checks,
        latencyMs: outcome.latencyMs, totalMs: result.totalMs, staleS: outcome.staleS,
      });

      // ---- 5. a signed SLA breach is claimable; settle it out of the bond
      if (outcome.provableViolation && result.body) {
        try {
          const claim = await client.claim({
            appId: env.appId,
            assetId: env.assetId,
            provider: chosen.provider,
            treasury: env.treasuryAddress,
            body: result.body,
          });
          const slashMicro = Math.max(0, chosen.price_micro * env.slashMultiplier);
          summary.claims++;
          summary.refundedMicro += claim.refundMicro;
          summary.slashedMicro += slashMicro;

          await store().insertClaim({
            request_id: result.body.request_id,
            provider: chosen.provider,
            payer: client.address,
            txid: claim.txid,
            refund_micro: claim.refundMicro,
            slash_micro: slashMicro,
            age_s: outcome.staleS,
            ts: new Date(),
          });

          record("claim_upheld", claim.txid, `${chosen.label} signed data ${outcome.staleS}s old against a ${sla.max_staleness_s}s SLA: refund + slash from bond`);
          invalidateScore(chosen.provider);
          const after = await scoreFor(chosen.provider, { fresh: true });
          publish({
            type: "claim", at: now(), runId,
            provider: chosen.provider, label: chosen.label,
            requestId: result.body.request_id, txid: claim.txid,
            refundMicro: claim.refundMicro, slashMicro,
            bondRemainingMicro: after?.bond_micro ?? 0,
            ageS: outcome.staleS,
          });
          if (after) {
            publish({
              type: "provider:update", at: now(),
              provider: after.provider, label: after.label,
              bondMicro: after.bond_micro, active: after.active,
              claimCount: after.onchain.claim_count, successCount: after.onchain.success_count,
            });
          }
        } catch (err) {
          const message = String((err as Error)?.message ?? err);
          publish({ type: "claim:error", at: now(), runId, provider: chosen.provider, message });
          log("error", `claim failed on call ${i}: ${message}`);
        }
      }

      if (pauseMs > 0) await sleep(pauseMs);
    }

    // ---- 6. attest the good calls on chain, batched
    if (env.deployerMnemonic && successBuffer.size > 0) {
      const deployer = algosdk.mnemonicToSecretKey(env.deployerMnemonic);
      for (const [provider, count] of successBuffer) {
        try {
          const txid = await recordSuccess(deployer, { appId: env.appId, provider, count });
          record("record_success", txid, `${count} verified good responses attested on chain`);
          log("info", `recorded ${count} verified good responses for ${provider.slice(0, 8)}… on chain`);
        } catch (err) {
          log("warn", `record_success failed for ${provider.slice(0, 8)}…: ${(err as Error).message}`);
        }
      }
      invalidateScore();
    }

    log(
      "info",
      `run complete — ${summary.paid} paid, ${summary.passed} passed, ${summary.failed} failed, ` +
        `${summary.claims} claims, ${fromMicro(summary.refundedMicro)} ${env.assetSymbol} refunded, ` +
        `${fromMicro(summary.slashedMicro)} ${env.assetSymbol} slashed`,
    );
    publish({ type: "demo:end", runId, at: now(), summary });
    return summary;
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    publish({ type: "demo:error", runId, at: now(), message });
    throw err;
  } finally {
    running = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Used by /health and the preflight script. */
export function demoProviders(): DemoProvider[] {
  return providers();
}
