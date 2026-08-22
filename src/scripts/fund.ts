/**
 * Spreads ALGO across the four demo accounts from one funded wallet.
 *
 * TestNet faucets are per-address and rate limited, so it is usually faster to
 * fund one account well and let this distribute. Pass --from with a mnemonic to
 * sweep from a wallet that is not the deployer.
 *
 *   npm run fund                              from DEPLOYER_MNEMONIC
 *   npm run fund -- --from "word word ..."    from any funded TestNet wallet
 */
import algosdk from "algosdk";
import { env, acctUrl, txUrl } from "../env.ts";
import { accountInfo, fundAccount } from "../lib/chain.ts";
import { bar, head, info, ok, warn } from "./_envfile.ts";

const TARGETS = [
  { label: "deployer/treasury", key: "deployerAddress", target: 5_000_000 },
  { label: "provider A", key: "providerAAddress", target: 1_000_000 },
  { label: "provider B", key: "providerBAddress", target: 1_000_000 },
  { label: "agent", key: "agentAddress", target: 2_000_000 },
] as const;

/** Leave enough behind that the source account stays above its own MBR. */
const SOURCE_RESERVE = 300_000;

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main(): Promise<void> {
  const mnemonic = arg("from") ?? env.deployerMnemonic;
  if (!mnemonic) throw new Error("no source wallet — pass --from or set DEPLOYER_MNEMONIC");
  const source = algosdk.mnemonicToSecretKey(mnemonic);
  const sourceAddr = source.addr.toString();

  console.log(bar());
  console.log("  DISTRIBUTE TESTNET ALGO");
  console.log(bar());

  const src = await accountInfo(sourceAddr);
  info("source", `${sourceAddr}`);
  info("balance", `${(src.microAlgos / 1e6).toFixed(3)} ALGO`);

  let budget = src.microAlgos - SOURCE_RESERVE;

  for (const t of TARGETS) {
    const address = env[t.key];
    if (!address) { warn(`${t.label}: address not set`); continue; }
    if (address === sourceAddr) { info(`${t.label} is the source`, "skipped"); continue; }

    head(t.label);
    let held = 0;
    try {
      held = (await accountInfo(address)).microAlgos;
    } catch {
      held = 0; // account does not exist on chain yet
    }

    const need = Math.max(0, t.target - held);
    if (need === 0) {
      info("already funded", `${(held / 1e6).toFixed(3)} ALGO`);
      continue;
    }
    // Every send also costs a fee out of the source.
    const send = Math.min(need, Math.max(0, budget - 1000));
    if (send <= 0) {
      warn("source exhausted", `${t.label} still needs ${(need / 1e6).toFixed(3)} ALGO`);
      info("fund directly", acctUrl(address));
      continue;
    }

    const txid = await fundAccount(source, address, send, "recourse:fund");
    budget -= send + 1000;
    ok(`sent ${(send / 1e6).toFixed(3)} ALGO`, txUrl(txid));
    if (send < need) warn("partial", `${((need - send) / 1e6).toFixed(3)} ALGO short`);
  }

  console.log(`\n${bar()}`);
  console.log("  next: npm run preflight");
  console.log(bar());
}

main().catch(err => {
  console.error("\nfund failed:", err?.message ?? err);
  process.exit(1);
});
