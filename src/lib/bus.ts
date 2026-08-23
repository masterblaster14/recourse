/**
 * A tiny in-process pub/sub so the dashboard can watch the agent work in real
 * time over SSE. Every meaningful step — a 402, a settled payment, a verify
 * result, a claim landing on chain, a routing decision — is published here.
 */

export type RecourseEvent =
  | { type: "demo:start"; runId: string; calls: number; at: string }
  | { type: "demo:end"; runId: string; at: string; summary: DemoSummary }
  | { type: "demo:error"; runId: string; at: string; message: string }
  | { type: "score"; at: string; provider: string; label: string; reliability: number;
      recommendation: string; confidence: string; bondMicro: number; coverageCalls: number }
  | { type: "route"; at: string; runId: string; index: number; chosen: string;
      chosenLabel: string; reason: string; candidates: RouteCandidate[] }
  | { type: "pay"; at: string; runId: string; index: number; provider: string; label: string;
      resource: string; amountMicro: number; txid: string | null; settled: boolean;
      /** Whether the agent refused to pay after reading the 402, and why. */
      refused?: boolean; refusedReason?: string;
      /** Independent on-chain confirmation of the facilitator's reported txid. */
      settlementVerified?: boolean; settlementReason?: string;
      /** Round trip for the paid request, settlement included. */
      latencyMs?: number;
      /**
       * Which half of the loop this payment belongs to. The agent buys risk
       * data before it buys anything else, and both are real x402 payments —
       * but a survey purchase is not the current call's resource purchase, and
       * a reader following one call needs to be able to tell them apart.
       */
      kind?: "survey" | "resource" }
  | { type: "verify"; at: string; runId: string; index: number; provider: string; label: string;
      pass: boolean; checks: CheckResult[]; latencyMs: number; totalMs: number; staleS: number }
  | { type: "claim"; at: string; runId: string; provider: string; label: string;
      requestId: string; txid: string; refundMicro: number; slashMicro: number;
      bondRemainingMicro: number; ageS: number }
  | { type: "claim:error"; at: string; runId: string; provider: string; message: string }
  | { type: "provider:update"; at: string; provider: string; label: string;
      bondMicro: number; active: boolean; claimCount: number; successCount: number }
  | { type: "log"; at: string; level: "info" | "warn" | "error"; message: string };

export type RouteCandidate = {
  provider: string;
  label: string;
  reliability: number;
  recommendation: string;
  confidence: string;
  bondMicro: number;
  coverageCalls: number;
  active: boolean;
  eligible: boolean;
  reason: string;
};

export type CheckResult = { name: string; pass: boolean; detail: string };

export type DemoSummary = {
  calls: number;
  paid: number;
  passed: number;
  failed: number;
  claims: number;
  refundedMicro: number;
  slashedMicro: number;
  spentMicro: number;
  routingSwitchedAt: number | null;
  byProvider: Record<string, { label: string; calls: number; passed: number; failed: number }>;
};

type Listener = (e: RecourseEvent) => void;

const listeners = new Set<Listener>();
const RING_SIZE = 400;
const ring: RecourseEvent[] = [];

export function publish(event: RecourseEvent): void {
  ring.push(event);
  if (ring.length > RING_SIZE) ring.shift();
  for (const l of listeners) {
    try {
      l(event);
    } catch {
      // A broken SSE pipe must never take down the agent loop.
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replayed to a dashboard that connects mid-run so it does not start blank. */
export function history(limit = RING_SIZE): RecourseEvent[] {
  return ring.slice(-limit);
}

export function clearHistory(): void {
  ring.length = 0;
}

export function now(): string {
  return new Date().toISOString();
}

export function log(level: "info" | "warn" | "error", message: string): void {
  publish({ type: "log", at: now(), level, message });
}
