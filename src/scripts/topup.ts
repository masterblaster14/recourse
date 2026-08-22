/**
 * Re-stake drained bonds between rehearsals.
 *
 * A demo run empties the violating provider's bond on purpose, which is the
 * point — but it also means the second run has nothing to slash. This puts the
 * bonds back without touching the on-chain claim history.
 *
 *   npm run topup                    both providers back to BOND_MICRO
 *   npm run topup -- --amount 0.2    a specific amount, in whole units
 */
import { env, fromMicro, toMicro, txUrl } from "../env.ts";
import { accountInfo, depositBond, fundAccount, readProvider, sendAsset } from "../lib/chain.ts";
import { providerAccount, providers } from "../lib/providers.ts";
import algosdk from "algosdk";
import { bar, head, info, ok, warn } from "./_envfile.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main(): Promise<void> {
  if (!env.appId) throw new Error("RECOURSE_APP_ID is not set");
  const amountArg = arg("amount");
  const target = amountArg ? toMicro(Number(amountArg)) : env.bondMicro;
  const perClaim = env.priceMicro * (1 + env.slashMultiplier);
  const deployer = env.deployerMnemonic ? algosdk.mnemonicToSecretKey(env.deployerMnemonic) : null;

  console.log(bar());
  console.log(`  TOP UP BONDS — target ${fromMicro(target)} ${env.assetSymbol} each`);
  console.log(bar());

  for (const p of providers()) {
    head(p.label);
    const onchain = await readProvider(env.appId, p.address);
    if (!onchain) { warn("not registered", "run `npm run setup`"); continue; }

    info("current bond", `${fromMicro(onchain.bondMicro)} ${env.assetSymbol} · ${onchain.active ? "active" : "INACTIVE"}`);
    const need = target - onchain.bondMicro;
    if (need <= 0) { info("already at target", "nothing to do"); continue; }

    // Refill the provider's wallet from the treasury if it cannot cover the stake.
    let held = (await accountInfo(p.address)).assets.find(a => a.assetId === env.assetId)?.amount ?? 0;
    if (held < need && deployer) {
      const treasuryHeld =
        (await accountInfo(deployer.addr.toString())).assets.find(a => a.assetId === env.assetId)?.amount ?? 0;
      const send = Math.min(need - held, treasuryHeld);
      if (send > 0) {
        const tx = await sendAsset(deployer, p.address, env.assetId, send);
        ok(`treasury sent ${fromMicro(send)} ${env.assetSymbol}`, txUrl(tx));
        held += send;
      }
    }

    if (held < need) {
      warn("cannot stake", `needs ${fromMicro(need)} ${env.assetSymbol}, holds ${fromMicro(held)}`);
      continue;
    }

    const res = await depositBond(providerAccount(p), {
      appId: env.appId,
      assetId: env.assetId,
      amountMicro: need,
    });
    ok(`staked ${fromMicro(need)} ${env.assetSymbol}`, txUrl(res.txid));
    info("bond now", `${fromMicro(res.bondMicro)} — covers ${Math.floor(res.bondMicro / perClaim)} upheld claims`);
  }

  console.log(`\n${bar()}`);
  console.log("  ready for another run. Clear observed samples too:");
  console.log(`    curl -X POST -H "x-admin-key: $ADMIN_KEY" ${env.publicUrl}/admin/reset`);
  console.log(bar());
}

main().catch(err => {
  console.error("\ntopup failed:", err?.message ?? err);
  process.exit(1);
});
