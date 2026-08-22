/**
 * Deploys the Recourse registry to TestNet and gets it into a usable state:
 *
 *   1. create the application
 *   2. fund the application account, generously — every box raises its minimum
 *      balance, and an app that cannot allocate a box fails claims for reasons
 *      that look nothing like the actual cause
 *   3. opt the application into the bond asset, or it cannot custody anything
 *   4. write RECOURSE_APP_ID back into .env
 *
 * Safe to re-run: pass --force to deploy a fresh app over an existing one.
 */
import algosdk from "algosdk";
import { env, appUrl, txUrl } from "../env.ts";
import {
  accountInfo,
  appOptInAsset,
  deployApp,
  fundAccount,
  readGlobalState,
} from "../lib/chain.ts";
import { record, resetProof } from "../lib/proof.ts";
import { bar, head, info, ok, setEnvValue } from "./_envfile.ts";

/**
 * What the application account actually needs, rather than a round number.
 *
 *   base account MBR            0.100
 *   2 provider boxes @ 0.0645   0.129
 *   ~30 claim boxes @ 0.0193    0.579  (bounded now that claims can be pruned)
 *   inner-transaction headroom  0.092
 *                               -----
 *                               0.900
 *
 * Over-funding is not free: every redeploy strands whatever is left in the old
 * application account, and the creator's per-app minimum balance is locked for
 * good. `destroy` reclaims both, but only for apps deployed with it.
 */
const APP_FUNDING_MICROALGO = 900_000;

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  if (!env.deployerMnemonic) throw new Error("DEPLOYER_MNEMONIC is not set");
  const deployer = algosdk.mnemonicToSecretKey(env.deployerMnemonic);

  console.log(bar());
  console.log("  DEPLOY RECOURSE REGISTRY");
  console.log(bar());

  if (env.appId && !force) {
    try {
      const g = await readGlobalState(env.appId);
      ok(`app ${env.appId} already deployed`, `asset ${g.assetId}, ${g.providerCount} providers`);
      info("re-deploy with", "npm run contract:deploy -- --force");
      return;
    } catch {
      info(`RECOURSE_APP_ID=${env.appId} is not readable, deploying fresh`);
    }
  }

  const balance = await accountInfo(deployer.addr.toString());
  info("deployer", `${deployer.addr.toString()}  ${(balance.microAlgos / 1e6).toFixed(3)} ALGO`);
  if (balance.microAlgos < APP_FUNDING_MICROALGO + 500_000) {
    throw new Error(
      `deployer needs at least ${((APP_FUNDING_MICROALGO + 500_000) / 1e6).toFixed(2)} ALGO, has ${(balance.microAlgos / 1e6).toFixed(3)}`,
    );
  }

  head("1. create application");
  const { appId, appAddress, txid } = await deployApp(deployer, env.assetId);
  ok(`app ${appId} created`, txUrl(txid));
  setEnvValue("RECOURSE_APP_ID", String(appId));
  // A new application means a new evidence file — see resetProof.
  resetProof({
    app_id: appId,
    app_address: appAddress,
    asset_id: env.assetId,
    asset_symbol: env.assetSymbol,
    treasury: deployer.addr.toString(),
    network: env.networkCaip2,
    facilitator: env.facilitatorUrl,
  });
  record("app_created", txid, `Recourse registry created, bonds held in asset ${env.assetId}`, { overwrite: true });
  info("app account", appAddress);

  head("2. fund the application account");
  const fundTx = await fundAccount(
    deployer,
    appAddress,
    APP_FUNDING_MICROALGO,
    "recourse:app-funding",
  );
  ok(`funded ${(APP_FUNDING_MICROALGO / 1e6).toFixed(2)} ALGO`, txUrl(fundTx));
  record("app_funded", fundTx, "app account funded for box MBR and payouts", { overwrite: true });

  head(`3. opt the app into ${env.assetSymbol}`);
  const optTx = await appOptInAsset(deployer, appId, env.assetId);
  ok(`app opted into asset ${env.assetId}`, txUrl(optTx));
  record("app_opt_in", optTx, `app opted into ${env.assetSymbol} so it can custody bonds`, { overwrite: true });

  head("4. persist");
  setEnvValue("RECOURSE_APP_ID", String(appId));
  ok("RECOURSE_APP_ID written to .env", String(appId));

  const g = await readGlobalState(appId);
  console.log(`\n${bar()}`);
  console.log(`  APP ID       ${appId}`);
  console.log(`  APP ADDRESS  ${appAddress}`);
  console.log(`  TREASURY     ${g.treasury}`);
  console.log(`  BOND ASSET   ${g.assetId} (${env.assetSymbol})`);
  console.log(`  EXPLORER     ${appUrl(appId)}`);
  console.log(`  CREATE TX    ${txUrl(txid)}`);
  console.log(bar());
  console.log("  next: npm run setup");
  console.log(bar());
}

main().catch(err => {
  console.error("\ndeploy failed:", err?.message ?? err);
  if (err?.response?.body) console.error(JSON.stringify(err.response.body, null, 2));
  process.exit(1);
});
