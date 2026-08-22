/**
 * Rewrites the "Live proof" table in README.md from proof.json.
 *
 * The evaluation is "show us a real transaction on Lora", so the links in the
 * README are generated from the transaction ids that were actually recorded as
 * each step ran, not transcribed by hand. Run it after a demo.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { env, acctUrl, appUrl, txUrl } from "../env.ts";
import { providers } from "../lib/providers.ts";
import { readProof, type ProofEntry } from "../lib/proof.ts";
import { bar, info, ok, warn } from "./_envfile.ts";

const README = resolve(process.cwd(), "README.md");
const START = "<!-- PROOF:START -->";
const END = "<!-- PROOF:END -->";

function cell(entry: ProofEntry | undefined, label?: string): string {
  if (!entry?.txid) return "_pending_";
  const text = label ?? `\`${entry.txid.slice(0, 8)}…\``;
  return `[${text}](${txUrl(entry.txid)})`;
}

function main(): void {
  const p = readProof();
  const rows: string[] = [];

  const liveUrl = env.publicUrl.includes("localhost")
    ? "_pending deploy_"
    : `[${env.publicUrl}](${env.publicUrl})`;

  rows.push(`| Live API + dashboard | ${liveUrl} |`);
  rows.push(
    p.app_id
      ? `| Recourse App ID (TestNet) | [\`${p.app_id}\`](${appUrl(p.app_id)}) |`
      : "| Recourse App ID (TestNet) | _pending_ |",
  );
  rows.push(`| App created | ${cell(p.app_created)} |`);
  rows.push(`| App funded (box MBR + payouts) | ${cell(p.app_funded)} |`);
  rows.push(`| App opted into ${p.asset_symbol} | ${cell(p.app_opt_in)} |`);

  for (const prov of providers()) {
    rows.push(
      `| ${prov.label} registered (SLA committed) | ${cell(p.provider_registered[prov.address])} |`,
    );
  }
  for (const prov of providers()) {
    rows.push(`| ${prov.label} bond staked | ${cell(p.bond_deposited[prov.address])} |`);
  }

  rows.push(`| **x402 payment settled** | ${cell(p.x402_payment)} |`);
  rows.push(`| **Upheld claim (refund + slash)** | ${cell(p.claim_upheld)} |`);
  rows.push(`| Verified successes attested | ${cell(p.record_success)} |`);
  rows.push(
    p.treasury
      ? `| Treasury (receives slashes) | [\`${p.treasury.slice(0, 8)}…\`](${acctUrl(p.treasury)}) |`
      : "| Treasury | _pending_ |",
  );
  rows.push(`| Payment asset | \`${p.asset_id}\` (${p.asset_symbol}) |`);
  rows.push(`| Facilitator | [GoPlausible](${p.facilitator}) |`);
  rows.push(`| Network | \`${p.network}\` (TestNet) |`);

  const block = [
    START,
    "## Live proof",
    "",
    "| Item | Link |",
    "|---|---|",
    ...rows,
    "",
    "`GET /proof` on the live API returns this table as JSON, recorded as each",
    "transaction lands rather than transcribed by hand.",
    END,
  ].join("\n");

  const readme = readFileSync(README, "utf8");
  const s = readme.indexOf(START);
  const e = readme.indexOf(END);
  if (s === -1 || e === -1) {
    console.error(`README.md is missing the ${START} / ${END} markers`);
    process.exit(1);
  }
  writeFileSync(README, readme.slice(0, s) + block + readme.slice(e + END.length), "utf8");

  console.log(bar());
  ok("README.md proof table regenerated");
  const pending = rows.filter(r => r.includes("_pending_")).length;
  if (pending > 0) warn(`${pending} row(s) still pending`, "run the demo, then re-run this");
  else info("every row has a live transaction link");
  console.log(bar());
}

main();
