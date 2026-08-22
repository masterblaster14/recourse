/**
 * Says exactly what is and is not ready, and what to do about it.
 *
 * Run this whenever something looks wrong. It is faster than reading logs and
 * it checks the things that actually break at 2am: funding, asset opt-ins,
 * the facilitator being reachable, and whether the app account can still pay
 * out the bonds it is holding.
 */
import algosdk from "algosdk";
import { env, fromMicro } from "../env.ts";
import { accountInfo, algod, chainHealthy, readGlobalState, readProvider } from "../lib/chain.ts";
import { providers, slaFor, slaHashFor } from "../lib/providers.ts";
import { bad, bar, head, info, ok, warn } from "./_envfile.ts";

/** What each account needs to *operate*. Redeploying the app costs ~1.6 ALGO
 *  more on top of the deployer's figure, which is a separate, softer check. */
const MIN_ALGO = { deployer: 400_000, provider: 300_000, agent: 400_000, app: 1_000_000 };
const REDEPLOY_HEADROOM = 2_000_000;

let failures = 0;
let warnings = 0;
const fail = (l: string, d = "") => { bad(l, d); failures++; };
const soft = (l: string, d = "") => { warn(l, d); warnings++; };

async function main(): Promise<void> {
  console.log(bar());
  console.log("  RECOURSE PREFLIGHT");
  console.log(bar());

  // ---------------------------------------------------------------- network
  head("Network");
  const chain = await chainHealthy();
  if (chain.ok) ok("algod reachable", `${env.algodUrl} — round ${chain.round}`);
  else fail("algod unreachable", `${env.algodUrl} — ${chain.error}`);

  // ------------------------------------------------------------ facilitator
  head("Facilitator");
  try {
    const res = await fetch(`${env.facilitatorUrl}/supported`);
    const body = (await res.json()) as { kinds: { network: string; scheme: string }[] };
    const match = body.kinds.find(
      k => k.network === env.networkCaip2 || env.networkCaip2.startsWith(k.network),
    );
    if (match) ok("facilitator supports our network", `${match.scheme} on ${match.network}`);
    else fail("facilitator does not list our network", env.networkCaip2);
  } catch (err) {
    fail("facilitator unreachable", `${env.facilitatorUrl} — ${(err as Error).message}`);
  }

  // ------------------------------------------------------------------ asset
  head(`Payment asset (${env.assetSymbol})`);
  try {
    const a = await algod().getAssetByID(env.assetId).do();
    const p = a.params!;
    ok(`asset ${env.assetId} exists`, `${p.name ?? "?"} / ${p.unitName ?? "?"} — ${p.decimals} dp`);
    if (Number(p.decimals) !== env.assetDecimals) {
      fail("decimals mismatch", `chain says ${p.decimals}, env says ${env.assetDecimals}`);
    }
  } catch (err) {
    fail(`asset ${env.assetId} not found on ${env.network}`, (err as Error).message);
  }

  // --------------------------------------------------------------- accounts
  head("Accounts");
  const accounts: { label: string; address: string; minAlgo: number; needsAsset: boolean }[] = [
    { label: "deployer/treasury", address: env.deployerAddress, minAlgo: MIN_ALGO.deployer, needsAsset: true },
    { label: "provider A", address: env.providerAAddress, minAlgo: MIN_ALGO.provider, needsAsset: true },
    { label: "provider B", address: env.providerBAddress, minAlgo: MIN_ALGO.provider, needsAsset: true },
    { label: "agent", address: env.agentAddress, minAlgo: MIN_ALGO.agent, needsAsset: true },
  ];

  for (const a of accounts) {
    if (!a.address) { fail(`${a.label}: address not set in .env`); continue; }
    try {
      const info_ = await accountInfo(a.address);
      const algoOk = info_.microAlgos >= a.minAlgo;
      const line = `${(info_.microAlgos / 1e6).toFixed(3)} ALGO`;
      if (algoOk) ok(`${a.label} funded`, `${line}  ${a.address.slice(0, 10)}…`);
      else fail(`${a.label} underfunded`, `${line}, needs ${(a.minAlgo / 1e6).toFixed(2)} — ${a.address}`);

      if (a.label.startsWith("deployer") && algoOk && info_.microAlgos < REDEPLOY_HEADROOM) {
        soft("deployer cannot fund another app deploy", `${line} — fine to run, top up before redeploying`);
      }

      if (a.needsAsset) {
        const h = info_.assets.find(x => x.assetId === env.assetId);
        if (!h) soft(`${a.label} not opted into ${env.assetSymbol}`, "run `npm run setup`");
        else info(`${a.label} holds`, `${fromMicro(h.amount)} ${env.assetSymbol}`);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("no accounts found") || msg.includes("404")) {
        fail(`${a.label} does not exist on chain yet`, `fund it: ${a.address}`);
      } else {
        fail(`${a.label} lookup failed`, msg);
      }
    }
  }

  // --------------------------------------------------------------- contract
  head("Contract");
  if (!env.appId) {
    fail("RECOURSE_APP_ID not set", "run `npm run contract:deploy`");
  } else {
    try {
      const g = await readGlobalState(env.appId);
      ok(`app ${env.appId} deployed`, `treasury ${g.treasury.slice(0, 10)}… asset ${g.assetId}`);
      if (g.assetId !== env.assetId) {
        fail("app asset mismatch", `app holds bonds in ${g.assetId}, env pays in ${env.assetId}`);
      }

      const appAddress = algosdk.getApplicationAddress(env.appId).toString();
      const appAcct = await accountInfo(appAddress);
      const spendable = appAcct.microAlgos - appAcct.minBalance;
      const line = `${(appAcct.microAlgos / 1e6).toFixed(3)} ALGO, MBR ${(appAcct.minBalance / 1e6).toFixed(3)}`;
      if (spendable >= 200_000) ok("app account funded", line);
      else fail("app account too close to its minimum balance", `${line} — boxes will fail to allocate`);

      const held = appAcct.assets.find(x => x.assetId === env.assetId);
      if (!held) fail(`app not opted into ${env.assetSymbol}`, "run `npm run contract:deploy` or setup");
      else {
        ok(`app opted into ${env.assetSymbol}`, `custody ${fromMicro(held.amount)}`);
        if (held.amount < g.totalBonded) {
          fail("app holds less than it owes", `${fromMicro(held.amount)} held vs ${fromMicro(g.totalBonded)} bonded`);
        }
      }

      info("registry", `${g.providerCount} providers, ${g.claimCount} claims, ${fromMicro(g.totalSlashed)} slashed`);
    } catch (err) {
      fail(`app ${env.appId} unreadable`, (err as Error).message);
    }
  }

  // --------------------------------------------------------------- providers
  head("Providers");
  for (const p of providers()) {
    if (!p.address) { fail(`${p.label}: address not set`); continue; }
    if (!p.signingSk) { fail(`${p.label}: signing key not set`); continue; }

    if (!env.appId) { soft(`${p.label}: cannot check registration, no app id`); continue; }
    const onchain = await readProvider(env.appId, p.address).catch(() => null);
    if (!onchain) { fail(`${p.label} not registered on chain`, "run `npm run setup`"); continue; }

    const pubkeyMatches = Buffer.compare(onchain.pubkey, p.pubkey) === 0;
    const slaMatches = Buffer.compare(onchain.slaHash, slaHashFor(p)) === 0;

    if (pubkeyMatches) ok(`${p.label} signing key matches chain`);
    else fail(`${p.label} signing key differs from chain`, "re-run setup: claims will be rejected");

    if (slaMatches) ok(`${p.label} SLA hash matches chain`);
    else fail(`${p.label} SLA hash differs`, "the published SLA is not the one staked against");

    const coverage = Math.floor(onchain.bondMicro / (onchain.priceMicro * (1 + env.slashMultiplier)));
    const state = onchain.active ? "active" : "INACTIVE";
    const detail = `bond ${fromMicro(onchain.bondMicro)} ${env.assetSymbol}, covers ${coverage} claims, ${state}`;
    if (onchain.bondMicro > 0 && onchain.active) ok(`${p.label} bonded`, detail);
    else soft(`${p.label} has no usable bond`, `${detail} — run \`npm run setup\` or POST /admin/topup`);

    info(`${p.label} SLA`, `max_staleness ${slaFor(p).max_staleness_s}s, max_latency ${slaFor(p).max_latency_ms}ms`);
  }

  // ------------------------------------------------------------------ config
  head("Config");
  const perClaim = env.priceMicro * (1 + env.slashMultiplier);
  info("price per call", `${fromMicro(env.priceMicro)} ${env.assetSymbol}`);
  info("cost of one upheld claim", `${fromMicro(perClaim)} ${env.assetSymbol} (refund + ${env.slashMultiplier}x slash)`);
  info("bond buys", `${Math.floor(env.bondMicro / perClaim)} upheld claims`);
  info("public url", env.publicUrl);
  if (env.publicUrl.includes("localhost")) {
    soft("PUBLIC_URL still points at localhost", "set it to the deployed URL before demoing");
  }

  console.log(`\n${bar()}`);
  if (failures === 0 && warnings === 0) console.log("  \x1b[32mALL CLEAR\x1b[0m — ready to demo");
  else if (failures === 0) console.log(`  \x1b[33m${warnings} warning(s)\x1b[0m — probably fine, read them`);
  else console.log(`  \x1b[31m${failures} blocker(s)\x1b[0m, ${warnings} warning(s)`);
  console.log(bar());
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error("preflight crashed:", err);
  process.exit(2);
});
