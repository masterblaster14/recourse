/**
 * Brings the deployed registry to a demo-ready state. Idempotent — run it as
 * often as you like.
 *
 *   1. opt every account into the bond asset
 *   2. distribute the asset from the deployer
 *   3. register both providers on chain, committing their SLA hash and the
 *      ed25519 key they will sign responses with
 *   4. stake the bonds
 *
 * Steps 1 and 3 need no asset balance, so this makes as much progress as it can
 * and tells you exactly what is still missing.
 */
import algosdk from "algosdk";
import { env, fromMicro, txUrl } from "../env.ts";
import {
  accountInfo,
  depositBond,
  fundAccount,
  optInAsset,
  readProvider,
  registerProvider,
  sendAsset,
} from "../lib/chain.ts";
import { providerAccount, providers, slaFor, slaHashFor } from "../lib/providers.ts";
import { recordProvider } from "../lib/proof.ts";
import { bad, bar, head, info, ok, warn } from "./_envfile.ts";

/** Five bonds' worth each, so a drained provider can be re-staked between
 *  rehearsals without another transfer from the treasury. */
const PROVIDER_ASSET_TARGET = () => env.bondMicro * 5;
/** Agent float for ~2000 paid calls, which is many full demo runs. */
const AGENT_ASSET_TARGET = 2_000_000;

async function main(): Promise<void> {
  if (!env.appId) throw new Error("RECOURSE_APP_ID is not set — run `npm run contract:deploy`");
  if (!env.deployerMnemonic) throw new Error("DEPLOYER_MNEMONIC is not set");
  if (!env.agentMnemonic) throw new Error("AGENT_MNEMONIC is not set");

  const deployer = algosdk.mnemonicToSecretKey(env.deployerMnemonic);
  const agent = algosdk.mnemonicToSecretKey(env.agentMnemonic);

  console.log(bar());
  console.log(`  RECOURSE SETUP — app ${env.appId}, asset ${env.assetId} (${env.assetSymbol})`);
  console.log(bar());

  // ------------------------------------------------ 0. ALGO for new accounts
  head("0. make sure every account can pay its own fees");
  const MIN_ALGO = 400_000;
  for (const p of providers()) {
    let held = 0;
    try {
      held = (await accountInfo(p.address)).microAlgos;
    } catch {
      held = 0; // never funded, so it does not exist on chain yet
    }
    if (held >= MIN_ALGO) { info(`${p.label} has ALGO`, `${(held / 1e6).toFixed(3)}`); continue; }
    const tx = await fundAccount(deployer, p.address, MIN_ALGO - held, "recourse:provider-algo");
    ok(`${p.label} funded with ALGO`, txUrl(tx));
  }

  // ------------------------------------------------------------ 1. opt-ins
  head(`1. opt accounts into ${env.assetSymbol}`);
  const wallets: { label: string; account: algosdk.Account }[] = [
    { label: "deployer/treasury", account: deployer },
    { label: "agent", account: agent },
    ...providers().map(p => ({ label: p.label, account: providerAccount(p) })),
  ];

  for (const w of wallets) {
    const txid = await optInAsset(w.account, env.assetId);
    if (txid) ok(`${w.label} opted in`, txUrl(txid));
    else info(`${w.label} already opted in`);
  }

  // ------------------------------------------------------- 2. distribute
  head(`2. distribute ${env.assetSymbol} from the deployer`);
  const deployerHeld =
    (await accountInfo(deployer.addr.toString())).assets.find(a => a.assetId === env.assetId)
      ?.amount ?? 0;
  info("deployer holds", `${fromMicro(deployerHeld)} ${env.assetSymbol}`);

  const targets = [
    ...providers().map(p => ({ label: p.label, address: p.address, target: PROVIDER_ASSET_TARGET() })),
    { label: "agent", address: agent.addr.toString(), target: AGENT_ASSET_TARGET },
  ];

  let distributed = 0;
  let shortfall = 0;
  for (const t of targets) {
    const held =
      (await accountInfo(t.address)).assets.find(a => a.assetId === env.assetId)?.amount ?? 0;
    const need = Math.max(0, t.target - held);
    if (need === 0) {
      info(`${t.label} already funded`, `${fromMicro(held)} ${env.assetSymbol}`);
      continue;
    }
    const available = deployerHeld - distributed;
    // Always leave the treasury something, it receives slash penalties.
    const send = Math.min(need, Math.max(0, available - 10_000));
    if (send <= 0) {
      shortfall += need;
      warn(`${t.label} short`, `needs ${fromMicro(need)} more ${env.assetSymbol}, deployer is empty`);
      continue;
    }
    const txid = await sendAsset(deployer, t.address, env.assetId, send);
    distributed += send;
    ok(`sent ${fromMicro(send)} ${env.assetSymbol} to ${t.label}`, txUrl(txid));
    if (send < need) {
      shortfall += need - send;
      warn(`${t.label} partially funded`, `${fromMicro(need - send)} ${env.assetSymbol} still short`);
    }
  }

  // -------------------------------------------------------- 3. register
  head("3. register providers on chain");
  for (const p of providers()) {
    const account = providerAccount(p);
    const sla = slaFor(p);
    const hash = slaHashFor(p);
    const existing = await readProvider(env.appId, p.address);

    const upToDate =
      existing &&
      Buffer.compare(existing.pubkey, p.pubkey) === 0 &&
      Buffer.compare(existing.slaHash, hash) === 0 &&
      existing.priceMicro === env.priceMicro &&
      existing.maxStaleness === sla.max_staleness_s &&
      existing.maxLatencyMs === sla.max_latency_ms;

    if (upToDate) {
      info(`${p.label} already registered`, `sla ${hash.toString("hex").slice(0, 16)}…`);
      continue;
    }

    const txid = await registerProvider(account, {
      appId: env.appId,
      pubkey: p.pubkey,
      slaHash: hash,
      priceMicro: env.priceMicro,
      maxStaleness: sla.max_staleness_s,
      maxLatencyMs: sla.max_latency_ms,
    });
    ok(`${p.label} registered`, txUrl(txid));
    recordProvider("provider_registered", p.address, txid, `${p.label} published its SLA on chain`);
    info(
      `  ${p.label} commits`,
      `max_staleness ${sla.max_staleness_s}s · max_latency ${sla.max_latency_ms}ms · sla ${hash.toString("hex").slice(0, 16)}…`,
    );
  }

  // ------------------------------------------------------------ 4. bonds
  head("4. stake bonds");
  const perClaim = env.priceMicro * (1 + env.slashMultiplier);
  for (const p of providers()) {
    const account = providerAccount(p);
    const onchain = await readProvider(env.appId, p.address);
    if (!onchain) { bad(`${p.label} is not registered, cannot bond`); continue; }

    if (onchain.bondMicro >= env.bondMicro) {
      info(
        `${p.label} already bonded`,
        `${fromMicro(onchain.bondMicro)} ${env.assetSymbol}, covers ${Math.floor(onchain.bondMicro / perClaim)} claims`,
      );
      continue;
    }

    const need = env.bondMicro - onchain.bondMicro;
    const held =
      (await accountInfo(p.address)).assets.find(a => a.assetId === env.assetId)?.amount ?? 0;
    if (held < need) {
      warn(
        `${p.label} cannot stake`,
        `needs ${fromMicro(need)} ${env.assetSymbol}, holds ${fromMicro(held)}`,
      );
      continue;
    }

    const res = await depositBond(account, {
      appId: env.appId,
      assetId: env.assetId,
      amountMicro: need,
    });
    ok(
      `${p.label} staked ${fromMicro(need)} ${env.assetSymbol}`,
      txUrl(res.txid),
    );
    recordProvider("bond_deposited", p.address, res.txid, `${p.label} staked ${fromMicro(need)} ${env.assetSymbol}`);
    info(`  ${p.label} bond`, `${fromMicro(res.bondMicro)} — covers ${Math.floor(res.bondMicro / perClaim)} upheld claims`);
  }

  // ----------------------------------------------------------- summary
  console.log(`\n${bar()}`);
  for (const p of providers()) {
    const s = await readProvider(env.appId, p.address);
    const line = s
      ? `bond ${fromMicro(s.bondMicro)} ${env.assetSymbol} · covers ${Math.floor(s.bondMicro / perClaim)} claims · ${s.active ? "active" : "INACTIVE"}`
      : "not registered";
    console.log(`  ${p.label.padEnd(20)} ${line}`);
  }
  console.log(bar());
  if (shortfall > 0) {
    console.log(
      `  \x1b[33mSTILL NEEDED: ${fromMicro(shortfall)} ${env.assetSymbol}\x1b[0m — fund the deployer and re-run:`,
    );
    console.log(`  ${deployer.addr.toString()}`);
    console.log("  TestNet USDC: https://faucet.circle.com  (choose Algorand Testnet)");
  } else {
    console.log("  next: npm run preflight   then   npm start");
  }
  console.log(bar());
}

main().catch(err => {
  console.error("\nsetup failed:", err?.message ?? err);
  if (err?.response?.body) console.error(JSON.stringify(err.response.body, null, 2));
  process.exit(1);
});
