/**
 * Finds and moves the payment asset into the demo accounts.
 *
 * Faucets usually go to whatever wallet you had open, not to the account this
 * project generated. This checks any address, and sweeps from any wallet you
 * hold the mnemonic for into the deployer, from where `npm run setup`
 * distributes it.
 *
 *   npm run sweep -- --check <ADDRESS>          just look
 *   npm run sweep -- --from "word word ..."     move it to the deployer
 *   npm run sweep -- --from "..." --amount 2    move a specific amount
 */
import algosdk from "algosdk";
import { env, fromMicro, toMicro, txUrl, acctUrl } from "../env.ts";
import { accountInfo, optInAsset, sendAsset } from "../lib/chain.ts";
import { bad, bar, head, info, ok, warn } from "./_envfile.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/** Leave a little behind so the source keeps working. */
const KEEP_MICRO = 0;

async function report(address: string, label: string): Promise<number> {
  try {
    const info_ = await accountInfo(address);
    const holding = info_.assets.find(a => a.assetId === env.assetId);
    const algo = (info_.microAlgos / 1e6).toFixed(3);
    if (!holding) {
      warn(`${label} not opted into ${env.assetSymbol}`, `${algo} ALGO · ${address}`);
      return 0;
    }
    if (holding.amount > 0) {
      ok(`${label} holds ${fromMicro(holding.amount)} ${env.assetSymbol}`, `${algo} ALGO`);
    } else {
      info(`${label} opted in, balance 0`, `${algo} ALGO`);
    }
    return holding.amount;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("no accounts found") || msg.includes("404")) {
      warn(`${label} does not exist on chain`, address);
    } else {
      bad(`${label} lookup failed`, msg);
    }
    return 0;
  }
}

async function main(): Promise<void> {
  console.log(bar());
  console.log(`  SWEEP ${env.assetSymbol} (asset ${env.assetId})`);
  console.log(bar());

  const check = arg("check");
  const fromMnemonic = arg("from");
  const amountArg = arg("amount");

  head("known accounts");
  await report(env.deployerAddress, "deployer/treasury");
  await report(env.providerAAddress, "provider A");
  await report(env.providerBAddress, "provider B");
  await report(env.agentAddress, "agent");

  if (check) {
    head("requested address");
    const held = await report(check, "checked");
    console.log(`\n${bar()}`);
    if (held > 0) {
      console.log(`  ${fromMicro(held)} ${env.assetSymbol} found. Move it here:`);
      console.log(`    ${env.deployerAddress}`);
      console.log("  or re-run with --from \"<that wallet's 25-word mnemonic>\" and I will move it.");
    } else {
      console.log(`  No ${env.assetSymbol} at that address.`);
      console.log(`  ${acctUrl(check)}`);
    }
    console.log(bar());
    return;
  }

  if (!fromMnemonic) {
    console.log(`\n${bar()}`);
    console.log("  Nothing to do. Give me one of:");
    console.log("    npm run sweep -- --check <ADDRESS>");
    console.log('    npm run sweep -- --from "<25-word mnemonic>"');
    console.log(bar());
    console.log(`  Or just send ${env.assetSymbol} straight to the deployer:`);
    console.log(`    ${env.deployerAddress}`);
    console.log(bar());
    return;
  }

  head("source wallet");
  const source = algosdk.mnemonicToSecretKey(fromMnemonic.trim().replace(/\s+/g, " "));
  const sourceAddr = source.addr.toString();
  const held = await report(sourceAddr, "source");
  if (held === 0) {
    console.log(`\n${bar()}`);
    bad(`source holds no ${env.assetSymbol}`, sourceAddr);
    console.log(bar());
    process.exit(1);
  }

  const want = amountArg ? toMicro(Number(amountArg)) : held - KEEP_MICRO;
  const send = Math.min(want, held);

  head("transfer");
  if (sourceAddr === env.deployerAddress) {
    info("source is already the deployer", "nothing to move");
  } else {
    // The receiver must be opted in; ours already are, but be safe.
    const deployerInfo = await accountInfo(env.deployerAddress);
    if (!deployerInfo.assets.some(a => a.assetId === env.assetId)) {
      if (!env.deployerMnemonic) throw new Error("deployer is not opted in and DEPLOYER_MNEMONIC is unset");
      const optTx = await optInAsset(algosdk.mnemonicToSecretKey(env.deployerMnemonic), env.assetId);
      if (optTx) ok("deployer opted in", txUrl(optTx));
    }
    const txid = await sendAsset(source, env.deployerAddress, env.assetId, send);
    ok(`sent ${fromMicro(send)} ${env.assetSymbol} to the deployer`, txUrl(txid));
  }

  console.log(`\n${bar()}`);
  console.log("  next: npm run setup   (distributes to providers and the agent, stakes the bonds)");
  console.log(bar());
}

main().catch(err => {
  console.error("\nsweep failed:", err?.message ?? err);
  process.exit(1);
});
