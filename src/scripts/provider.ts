/**
 * The provider CLI — bring your own endpoint.
 *
 * Recourse has no admin, no allow-list and no approval step: `register` and
 * `deposit_bond` both key off `Txn.sender`, so a provider enrols itself from
 * its own wallet and nobody here can enrol it, block it, or touch its bond.
 * This script is the ergonomics around that, not a gatekeeper — everything it
 * does is an ordinary application call anyone could make with algosdk.
 *
 * Three steps, deliberately separate:
 *
 *   init      generate a response-signing key and print the SLA to publish
 *   register  commit that SLA on chain and stake collateral behind it
 *   test      buy from the endpoint as an agent would, and say plainly
 *             whether what came back would have cost you your bond
 *
 * `test` is the one that matters. Registering is a promise; the bond makes the
 * promise expensive. A provider that has not checked whether its own endpoint
 * survives its own SLA is staking money on an assumption, and the whole point
 * of this project is that assumptions about counterparties are worth checking
 * before the money moves rather than after.
 */
import algosdk from "algosdk";
import { env, fromMicro, toMicro, txUrl, acctUrl } from "../env.ts";
import {
  accountInfo,
  depositBond,
  optInAsset,
  readProvider,
  registerProvider,
} from "../lib/chain.ts";
import { REQUIRED_FIELDS, type Sla } from "../lib/providers.ts";
import { RecourseClient, defaultSpendPolicy } from "../lib/recourse-client.ts";
import { slaHash } from "../lib/signing.ts";
import { bad, bar, head, info, ok, warn } from "./_envfile.ts";

/* -------------------------------------------------------------- arguments -- */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : undefined;
}

function numArg(name: string, fallback: number): number {
  const v = arg(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${v}"`);
  return n;
}

/** Accepts a mnemonic on the command line or in the environment. */
function accountFrom(name: string, envValue?: string): algosdk.Account {
  const m = arg(name) ?? envValue;
  if (!m) {
    throw new Error(
      `no wallet — pass --${name} "twenty five words", or set it in .env`,
    );
  }
  return algosdk.mnemonicToSecretKey(m.trim());
}

/* ------------------------------------------------------------------- init -- */

/**
 * The response-signing key is deliberately NOT the key that holds the bond.
 * Signing happens on every request, so that key is hot by definition; the bond
 * key signs twice in its life. Keeping them separate means a compromised web
 * server leaks the ability to sign responses, not the collateral itself.
 */
function newSigningKey(): { skB64: string; pkB64: string } {
  const a = algosdk.generateAccount();
  return {
    skB64: Buffer.from(a.sk).toString("base64"),
    pkB64: Buffer.from(a.addr.publicKey).toString("base64"),
  };
}

async function cmdInit(): Promise<void> {
  const address = arg("address") ?? accountFrom("mnemonic").addr.toString();
  const priceMicro = arg("price") ? toMicro(numArg("price", 0)) : env.priceMicro;
  const staleness = numArg("staleness", env.maxStalenessS);
  const latency = numArg("latency", env.maxLatencyMs);

  const key = newSigningKey();

  const sla: Sla = {
    version: 1,
    provider: address,
    network: env.networkCaip2,
    asset: { id: env.assetId, symbol: env.assetSymbol, decimals: env.assetDecimals },
    price_micro: priceMicro,
    max_staleness_s: staleness,
    max_latency_ms: latency,
    required_fields: [...REQUIRED_FIELDS],
    signing: {
      algorithm: "ed25519",
      message: "request_id(32) || sha256(canonical_json(data))(32) || uint64_be(data_timestamp)",
      pubkey_b64: key.pkB64,
    },
  };

  const hash = slaHash(sla);

  console.log(bar());
  console.log("  PROVIDER INIT — nothing has touched the chain yet");
  console.log(bar());

  head("1. keep this secret — it signs every response you serve");
  console.log(`\nPROVIDER_SIGNING_SK=${key.skB64}\n`);
  warn("if this leaks", "an attacker can sign responses in your name, and you carry the bond");

  head("2. publish this document, unchanged, at a URL agents can fetch");
  console.log(`\n${JSON.stringify(sla, null, 2)}\n`);
  info("byte-for-byte", "its sha256 is committed on chain — one changed space breaks every claim check");

  head("3. the commitment this becomes");
  info("sla_hash", `0x${hash.toString("hex")}`);
  info("price", `${fromMicro(priceMicro)} ${env.assetSymbol} per call`);
  info("max staleness", `${staleness}s — data older than this is a provable breach`);
  info("max latency", `${latency}ms`);

  console.log(`\n${bar()}`);
  console.log("  next:  npm run provider:register -- --sla-url <where you published it> \\");
  console.log("           --bond 0.2 --mnemonic \"your twenty five words\"");
  console.log(bar());
}

/* --------------------------------------------------------------- register -- */

/** Accepts either a bare SLA document or the `{ provider, label, sla }` shape
 *  this API serves, so a provider can point at either and it just works. */
function extractSla(payload: unknown): Sla {
  const p = payload as { sla?: unknown };
  const doc = (p && typeof p === "object" && p.sla ? p.sla : payload) as Sla;
  if (!doc || typeof doc !== "object") throw new Error("response was not a JSON object");

  const missing: string[] = [];
  if (typeof doc.provider !== "string" || !doc.provider) missing.push("provider");
  if (typeof doc.price_micro !== "number") missing.push("price_micro");
  if (typeof doc.max_staleness_s !== "number") missing.push("max_staleness_s");
  if (typeof doc.max_latency_ms !== "number") missing.push("max_latency_ms");
  if (!doc.signing?.pubkey_b64) missing.push("signing.pubkey_b64");
  if (missing.length) throw new Error(`SLA is missing ${missing.join(", ")}`);

  if (Buffer.from(doc.signing.pubkey_b64, "base64").length !== 32) {
    throw new Error("signing.pubkey_b64 is not a 32-byte ed25519 public key");
  }
  return doc;
}

async function fetchSla(url: string): Promise<Sla> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return extractSla(await res.json());
}

async function cmdRegister(): Promise<void> {
  if (!env.appId) throw new Error("RECOURSE_APP_ID is not set");

  const slaUrl = arg("sla-url");
  if (!slaUrl) throw new Error("--sla-url is required — the URL where you published your SLA");

  const account = accountFrom("mnemonic");
  const address = account.addr.toString();
  const bondMicro = arg("bond") ? toMicro(numArg("bond", 0)) : env.bondMicro;

  console.log(bar());
  console.log(`  PROVIDER REGISTER — app ${env.appId} on ${env.network}`);
  console.log(bar());
  info("wallet", address);

  // ---------------------------------------------------- 1. the published SLA
  head("1. read the SLA you published");
  const sla = await fetchSla(slaUrl);
  ok("fetched", slaUrl);

  // The document names an owner. If it is not this wallet, the pubkey inside it
  // belongs to somebody else and registering it here would commit their key
  // against our collateral.
  if (sla.provider !== address) {
    bad("the SLA names a different provider", `${sla.provider} != ${address}`);
    throw new Error("refusing to stake this wallet's bond behind another wallet's SLA");
  }
  ok("SLA belongs to this wallet");

  const hash = slaHash(sla);
  info("sla_hash", `0x${hash.toString("hex")}`);
  info("price", `${fromMicro(sla.price_micro)} ${env.assetSymbol}`);
  info("max staleness", `${sla.max_staleness_s}s`);
  info("max latency", `${sla.max_latency_ms}ms`);

  // --------------------------------------------------------- 2. can it pay?
  head("2. check the wallet can act");
  let acct;
  try {
    acct = await accountInfo(address);
  } catch {
    throw new Error(`${address} does not exist on chain yet — fund it with TestNet ALGO first`);
  }
  info("ALGO", `${(acct.microAlgos / 1e6).toFixed(3)}`);
  if (acct.microAlgos < 300_000) {
    warn("low ALGO", "registering and bonding need fees plus box minimum balance");
  }

  const optTx = await optInAsset(account, env.assetId);
  if (optTx) ok(`opted into ${env.assetSymbol}`, txUrl(optTx));
  else info(`already opted into ${env.assetSymbol}`);

  const held =
    (await accountInfo(address)).assets.find(a => a.assetId === env.assetId)?.amount ?? 0;
  info(env.assetSymbol, `${fromMicro(held)}`);
  if (held < bondMicro) {
    throw new Error(
      `not enough ${env.assetSymbol} to post the bond: have ${fromMicro(held)}, need ${fromMicro(bondMicro)}`,
    );
  }

  // ------------------------------------------------- 3. existing registration
  const existing = await readProvider(env.appId, address);
  if (existing && existing.bondMicro > 0) {
    head("3. already registered and bonded");
    warn("terms are frozen while bonded", "the contract rejects changes until the bond is withdrawn");
    info("current bond", `${fromMicro(existing.bondMicro)} ${env.assetSymbol}`);
    info("to change terms", "npm run provider:unbond, wait out the cooldown, then register again");
    console.log(bar());
    return;
  }

  // -------------------------------------------------------- 4. commit on chain
  head("3. commit the terms on chain");
  const regTx = await registerProvider(account, {
    appId: env.appId,
    pubkey: Buffer.from(sla.signing.pubkey_b64, "base64"),
    slaHash: hash,
    priceMicro: sla.price_micro,
    maxStaleness: sla.max_staleness_s,
    maxLatencyMs: sla.max_latency_ms,
  });
  ok("registered", txUrl(regTx));

  head("4. stake the collateral");
  const bond = await depositBond(account, {
    appId: env.appId,
    assetId: env.assetId,
    amountMicro: bondMicro,
  });
  ok(`bonded ${fromMicro(bondMicro)} ${env.assetSymbol}`, txUrl(bond.txid));

  // ------------------------------------------------------------- 5. read back
  head("5. confirm by reading the chain, not by trusting this script");
  const onchain = await readProvider(env.appId, address);
  if (!onchain) throw new Error("registration did not land — nothing in box storage");

  const committed = Buffer.from(onchain.slaHash).toString("hex");
  if (committed !== hash.toString("hex")) {
    bad("committed hash does not match the published SLA", committed);
    throw new Error("registration landed but the SLA hash differs — do not serve traffic");
  }
  ok("sla_hash on chain matches the document you published");
  ok("bond", `${fromMicro(onchain.bondMicro)} ${env.assetSymbol}`);
  info("coverage", `${Math.floor(onchain.bondMicro / (sla.price_micro * 10))} failed calls before it is exhausted`);
  info("account", acctUrl(address));

  console.log(`\n${bar()}`);
  console.log("  You are live and slashable. Before sending real traffic:");
  console.log("    npm run provider:test -- --endpoint <your paid endpoint>");
  console.log(bar());
}

/* ------------------------------------------------------------------- test -- */

async function cmdTest(): Promise<void> {
  if (!env.appId) throw new Error("RECOURSE_APP_ID is not set");

  const endpoint = arg("endpoint");
  if (!endpoint) throw new Error("--endpoint is required — the paid URL an agent would buy");

  const buyer = accountFrom("buyer-mnemonic", env.agentMnemonic);
  const provider =
    arg("provider") ?? (arg("mnemonic") ? accountFrom("mnemonic").addr.toString() : "");
  if (!provider) throw new Error("pass --provider <address> or --mnemonic to identify the seller");

  console.log(bar());
  console.log("  PROVIDER TEST — buying from your endpoint exactly as an agent would");
  console.log(bar());
  info("endpoint", endpoint);
  info("seller", provider);
  info("buyer", buyer.addr.toString());

  // ------------------------------------------------- 1. what did you commit?
  head("1. read your commitment from the chain");
  const onchain = await readProvider(env.appId, provider);
  if (!onchain) throw new Error(`${provider} is not registered — run provider:register first`);
  ok("registered", `bond ${fromMicro(onchain.bondMicro)} ${env.assetSymbol}`);
  info("max staleness", `${onchain.maxStaleness}s`);
  info("max latency", `${onchain.maxLatencyMs}ms`);
  if (onchain.bondMicro === 0) {
    warn("no bond", "nothing here is slashable, and no agent has a reason to prefer you");
  }

  // ------------------------------------------- 2. chain of custody on the key
  head("2. check your published SLA still matches what is on chain");
  const slaUrl = arg("sla-url");
  let pubkey = Buffer.from(onchain.pubkey);
  if (slaUrl) {
    const sla = await fetchSla(slaUrl);
    const computed = slaHash(sla);
    if (computed.toString("hex") !== Buffer.from(onchain.slaHash).toString("hex")) {
      bad("published SLA does not hash to your on-chain commitment");
      info("on chain", `0x${Buffer.from(onchain.slaHash).toString("hex")}`);
      info("published", `0x${computed.toString("hex")}`);
      throw new Error("an agent following the chain of custody will refuse to trust your key");
    }
    ok("published SLA matches the on-chain hash");
    pubkey = Buffer.from(sla.signing.pubkey_b64, "base64");
  } else {
    info("skipped", "pass --sla-url to verify your published document too");
  }

  // ------------------------------------------------------------- 3. buy it
  head("3. pay for one response over x402");
  const client = new RecourseClient(
    algosdk.secretKeyToMnemonic(buyer.sk),
    defaultSpendPolicy(),
  );
  const result = await client.buy(endpoint, { payTo: provider, assetId: env.assetId });

  if (result.refused) {
    bad("the agent refused to pay", result.error ?? "the 402 did not match what was expected");
    throw new Error("a real agent would have walked away here");
  }
  if (result.paymentFailed) {
    bad("payment did not settle", result.error ?? "");
    throw new Error("the x402 exchange never completed, so your endpoint was never tested");
  }
  ok(`paid`, result.settlement?.transaction ? txUrl(result.settlement.transaction) : "settled");
  if (result.settlementCheck) {
    const c = result.settlementCheck;
    if (c.verified) ok("settlement confirmed on chain", "asset, amount, sender and receiver all match");
    else bad("settlement did not check out on chain", c.reason);
  }

  // ---------------------------------------------------------- 4. six checks
  head("4. the six checks an agent runs on what you served");
  const outcome = client.verify(
    result,
    { max_staleness_s: onchain.maxStaleness, max_latency_ms: onchain.maxLatencyMs },
    pubkey,
  );

  for (const c of outcome.checks) {
    if (c.pass) ok(c.name, c.detail);
    else bad(c.name, c.detail);
  }

  // -------------------------------------------------------------- 5. verdict
  console.log(`\n${bar()}`);
  if (outcome.pass) {
    console.log("  PASS — this response honoured everything you committed to.");
    console.log(`  Nothing here is claimable. Your ${fromMicro(onchain.bondMicro)} ${env.assetSymbol} is safe.`);
  } else if (outcome.provableViolation) {
    const refund = onchain.priceMicro;
    const penalty = onchain.priceMicro * env.slashMultiplier;
    console.log("  SLASHABLE — you signed a response that breaks your own SLA.");
    console.log(`  Anyone holding it can take ${fromMicro(refund + penalty)} ${env.assetSymbol} from your bond`);
    console.log(`  (${fromMicro(refund)} refund + ${fromMicro(penalty)} penalty), and the contract will let them.`);
    console.log("  Fix the endpoint before you send traffic. This is the cheapest time to find out.");
  } else {
    console.log("  FAIL — an agent would mark this down and route away from you.");
    console.log("  Not slashable: without a valid signature over a breaching timestamp there is");
    console.log("  no proof, and Recourse never takes collateral on anything short of proof.");
  }
  console.log(bar());

  if (!outcome.pass) process.exitCode = 1;
}

/* ------------------------------------------------------------------- main -- */

const USAGE = `
Recourse provider CLI — bring your own endpoint.

  npm run provider:init -- --address <ALGO address> [--price 0.001]
                           [--staleness 60] [--latency 8000]
      Generate a response-signing key and print the SLA document to publish.
      Touches nothing on chain.

  npm run provider:register -- --sla-url <url> --bond 0.2 --mnemonic "..."
      Commit that SLA on chain and stake collateral behind it. Self-service:
      there is no approval step and no admin who could refuse you.

  npm run provider:test -- --endpoint <paid url> --provider <address>
                           [--sla-url <url>] [--buyer-mnemonic "..."]
      Buy one response as an agent would, run the six checks, and say whether
      what you served would have cost you your bond.
`;

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "init":     return cmdInit();
    case "register": return cmdRegister();
    case "test":     return cmdTest();
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch(err => {
  console.error(`\n${bad.name ? "" : ""}error: ${String((err as Error)?.message ?? err)}`);
  process.exit(1);
});
