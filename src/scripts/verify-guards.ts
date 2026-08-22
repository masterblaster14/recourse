/**
 * Adversarial check against the deployed contract.
 *
 * The happy path is easy to demo and proves very little. What matters is that
 * the guarantees hold when someone tries to abuse them, so this buys real
 * responses and then attempts four claims that MUST be rejected on chain:
 *
 *   1. a fresh response          -> "within SLA", nothing was breached
 *   2. a tampered signature      -> "bad signature", the provider did not sign it
 *   3. a tampered timestamp      -> "bad signature", the signature covers the timestamp
 *   4. a replay of a real claim  -> "already claimed", one response pays once
 *
 * Then one claim that must succeed, so a passing run also proves the rejections
 * are not just the contract being broken.
 *
 *   npm run verify:guards
 */
import { env, fromMicro, txUrl } from "../env.ts";
import { readProvider } from "../lib/chain.ts";
import { providerByVariant } from "../lib/providers.ts";
import { agentClient, type SignedResponse } from "../lib/recourse-client.ts";
import { bad, bar, head, info, ok } from "./_envfile.ts";

let passed = 0;
let failed = 0;

/** Asserts the claim is rejected, and that it is rejected for the right reason. */
async function mustReject(
  label: string,
  expect: RegExp,
  attempt: () => Promise<unknown>,
): Promise<void> {
  try {
    await attempt();
    bad(`${label} — WAS ACCEPTED`, "the contract should have rejected this");
    failed++;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (expect.test(msg)) {
      ok(`${label} — rejected`, `matched /${expect.source}/`);
      passed++;
    } else {
      // Still rejected, but check the reason rather than accept any failure.
      bad(`${label} — rejected for the wrong reason`, msg.slice(0, 200));
      failed++;
    }
  }
}

async function main(): Promise<void> {
  if (!env.appId) throw new Error("RECOURSE_APP_ID is not set");
  const client = agentClient();
  const compliant = providerByVariant("compliant")!;
  const stale = providerByVariant("stale")!;
  const base = env.publicUrl;

  console.log(bar());
  console.log(`  CONTRACT GUARD CHECKS — app ${env.appId}`);
  console.log(bar());
  info("agent", client.address);

  const before = await readProvider(env.appId, stale.address);
  info("violating provider bond", `${fromMicro(before?.bondMicro ?? 0)} ${env.assetSymbol}`);
  if (!before?.active || before.bondMicro < env.priceMicro * (1 + env.slashMultiplier)) {
    bad("violating provider has no usable bond", "run `npm run topup` first");
    process.exit(1);
  }

  head("buy the evidence");
  const freshBuy = await client.buy(compliant.endpoint);
  const staleBuy = await client.buy(stale.endpoint);
  if (!freshBuy.body || !staleBuy.body) {
    bad("could not buy responses", freshBuy.error ?? staleBuy.error ?? "unknown");
    process.exit(1);
  }
  ok("bought a compliant response", `${freshBuy.body.request_id.slice(0, 12)}…`);
  ok("bought a violating response", `${staleBuy.body.request_id.slice(0, 12)}…`);

  const claimWith = (provider: string, body: SignedResponse) =>
    client.claim({ appId: env.appId, assetId: env.assetId, provider, treasury: env.treasuryAddress, body });

  head("claims that must be rejected");

  // 1. Nothing was breached — the response is inside the staleness bound.
  await mustReject("fresh response claimed as stale", /within SLA|assert/i, () =>
    claimWith(compliant.address, freshBuy.body!),
  );

  // 2. Signature does not verify against the pubkey committed on chain.
  const badSig = Buffer.from(staleBuy.body.signature, "base64");
  badSig[10] ^= 0xff;
  await mustReject("tampered signature", /bad signature|assert/i, () =>
    claimWith(stale.address, { ...staleBuy.body!, signature: badSig.toString("base64") }),
  );

  // 3. The signature covers the timestamp, so moving it invalidates the proof.
  await mustReject("tampered timestamp", /bad signature|assert/i, () =>
    claimWith(stale.address, { ...staleBuy.body!, data_timestamp: staleBuy.body!.data_timestamp + 1 }),
  );

  head("the claim that must succeed");
  let realClaimTx = "";
  try {
    const res = await claimWith(stale.address, staleBuy.body);
    realClaimTx = res.txid;
    ok(`genuine violation upheld`, `refunded ${fromMicro(res.refundMicro)} ${env.assetSymbol}`);
    info("transaction", txUrl(res.txid));
    passed++;
  } catch (err) {
    bad("genuine violation was rejected", String((err as Error).message).slice(0, 200));
    failed++;
  }

  head("replay guard");
  if (realClaimTx) {
    // 4. Same request_id, same everything — must not pay twice.
    await mustReject("replay of an upheld claim", /already claimed|assert/i, () =>
      claimWith(stale.address, staleBuy.body!),
    );
  }

  const after = await readProvider(env.appId, stale.address);
  head("net effect");
  info(
    "bond",
    `${fromMicro(before.bondMicro)} -> ${fromMicro(after?.bondMicro ?? 0)} ${env.assetSymbol}` +
      ` (exactly one claim's worth: ${fromMicro(env.priceMicro * (1 + env.slashMultiplier))})`,
  );
  info("claims on chain", `${before.claimCount} -> ${after?.claimCount ?? 0}`);

  console.log(`\n${bar()}`);
  if (failed === 0) console.log(`  \x1b[32mALL ${passed} GUARD CHECKS PASSED\x1b[0m`);
  else console.log(`  \x1b[31m${failed} FAILED\x1b[0m, ${passed} passed`);
  console.log(bar());
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error("\nguard checks crashed:", err?.message ?? err);
  process.exit(2);
});
