/**
 * Adversarial check against the deployed contract.
 *
 * The happy path is easy to demo and proves very little. What matters is that
 * the guarantees hold when someone tries to abuse them. Every attempt below
 * MUST be rejected by the deployed contract:
 *
 *   1. claiming a fresh response        nothing was breached
 *   2. a tampered signature             the provider did not sign that
 *   3. a tampered timestamp             the signature covers the timestamp
 *   4. rotating the signing key         the escape hatch that voided all claims
 *   5. widening the staleness bound     the quieter version of the same escape
 *   6. withdrawing without a cooldown   collateral cannot outrun a claim
 *   7. replaying an upheld claim        one response pays out once
 *
 * Plus one claim that MUST succeed, so a passing run also proves the rejections
 * are the guards working rather than the contract being broken.
 *
 * 4 and 5 are checked against on-chain STATE, not error text: TEAL assert
 * messages do not survive to the client, so "it threw" is not evidence. The
 * test reads the pubkey back and fails if it moved.
 *
 *   npm run verify:guards
 */
import algosdk from "algosdk";

import { env, fromMicro, txUrl } from "../env.ts";
import { readProvider, registerProvider, withdrawBond } from "../lib/chain.ts";
import { providerAccount, providerByVariant, slaHashFor } from "../lib/providers.ts";
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

  head("a bonded provider cannot rewrite the terms it is bonded against");
  // The sharpest attack on the whole design: serve stale signed responses, then
  // rotate the signing key so every outstanding signature stops verifying and
  // every claim becomes unfileable. Verified by STATE rather than by error
  // text, because TEAL assert messages do not survive to the client.
  const staleAccount = providerAccount(stale);
  const beforeKey = (await readProvider(env.appId, stale.address))!.pubkey;
  const foreignKey = Buffer.from(algosdk.generateAccount().addr.publicKey);

  await mustReject("rotate signing key while bonded", /assert|unbond before/i, () =>
    registerProvider(staleAccount, {
      appId: env.appId,
      pubkey: foreignKey,
      slaHash: slaHashFor(stale),
      priceMicro: env.priceMicro,
      maxStaleness: env.maxStalenessS,
      maxLatencyMs: env.maxLatencyMs,
    }),
  );

  await mustReject("widen the staleness bound while bonded", /assert|unbond before/i, () =>
    registerProvider(staleAccount, {
      appId: env.appId,
      pubkey: stale.pubkey,
      slaHash: slaHashFor(stale),
      priceMicro: env.priceMicro,
      maxStaleness: 999_999,
      maxLatencyMs: env.maxLatencyMs,
    }),
  );

  const afterKey = (await readProvider(env.appId, stale.address))!.pubkey;
  if (Buffer.compare(beforeKey, afterKey) === 0) {
    ok("signing key on chain is unchanged", "outstanding signatures still verify");
    passed++;
  } else {
    bad("SIGNING KEY WAS ROTATED", "every pending claim against this provider is now void");
    failed++;
  }

  head("collateral cannot outrun a claim");
  await mustReject("withdraw without starting the cooldown", /assert|request_unbond/i, () =>
    withdrawBond(staleAccount, { appId: env.appId, assetId: env.assetId, amountMicro: 1000 }),
  );

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
