/**
 * Terminal view of a live run.
 *
 * Triggers the agent inside the running server and streams the same event feed
 * the dashboard renders, so the CLI and the browser show one run rather than
 * two. If the dashboard is not done in time, this is the fallback: a clean
 * terminal session with transaction links beats a half-built UI.
 *
 *   npm run demo                against PUBLIC_URL
 *   npm run demo -- --calls 50 --url https://recourse.up.railway.app
 */
import { env, fromMicro, txUrl } from "../env.ts";
import type { RecourseEvent } from "../lib/bus.ts";
import { bar } from "./_envfile.ts";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m",
  blue: "\x1b[36m", violet: "\x1b[35m", grey: "\x1b[90m",
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const baseUrl = arg("url", env.publicUrl).replace(/\/$/, "");
const calls = Number(arg("calls", "30"));
const short = (s: string, n = 10) => (s ? `${s.slice(0, n)}…` : "—");

async function main(): Promise<void> {
  console.log(bar());
  console.log(`  ${C.bold}RECOURSE LIVE DEMO${C.reset}   ${calls} x402 calls against ${baseUrl}`);
  console.log(`  ${C.grey}real payments on Algorand TestNet via the GoPlausible facilitator${C.reset}`);
  console.log(bar());

  const health = await fetch(`${baseUrl}/health`).then(r => r.json()).catch(() => null);
  if (!health) throw new Error(`cannot reach ${baseUrl} — is the server running? (npm start)`);
  if (!health.app_id) throw new Error("server reports no RECOURSE_APP_ID");
  console.log(`  app ${health.app_id} · asset ${health.asset.symbol} · chain round ${health.chain?.last_round}\n`);

  // Start streaming before triggering, so nothing is missed.
  const stream = listen();
  await new Promise(r => setTimeout(r, 400));

  const res = await fetch(`${baseUrl}/admin/demo`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-key": env.adminKey },
    body: JSON.stringify({ calls }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`could not start demo: ${res.status} ${(e as { error?: string }).error ?? ""}`);
  }

  await stream;
}

function listen(): Promise<void> {
  return new Promise((resolve, reject) => {
    fetch(`${baseUrl}/events`, { headers: { accept: "text/event-stream" } })
      .then(async res => {
        if (!res.body) return reject(new Error("no event stream"));
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        const startedAt = Date.now();
        let seenStart = false;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.split("\n").find(l => l.startsWith("data:"));
            if (!line) continue;
            let ev: RecourseEvent;
            try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }

            // Ignore replayed history from before we connected.
            if (!seenStart && ev.type !== "demo:start") continue;
            if (ev.type === "demo:start") { seenStart = true; }

            render(ev);
            if (ev.type === "demo:end") {
              console.log(`\n  ${C.grey}elapsed ${((Date.now() - startedAt) / 1000).toFixed(0)}s${C.reset}`);
              return resolve();
            }
            if (ev.type === "demo:error") return reject(new Error(ev.message));
          }
        }
        resolve();
      })
      .catch(reject);
  });
}

function render(ev: RecourseEvent): void {
  const sym = env.assetSymbol;
  switch (ev.type) {
    case "demo:start":
      console.log(`${C.dim}${bar()}${C.reset}`);
      break;

    case "route": {
      const out = ev.candidates.filter(c => !c.eligible);
      if (out.length > 0) {
        for (const c of out) {
          console.log(`  ${C.red}${C.bold}EXCLUDED${C.reset} ${c.label} — ${c.reason}`);
        }
      }
      process.stdout.write(
        `${C.grey}${String(ev.index).padStart(3)}${C.reset} → ${C.bold}${ev.chosenLabel}${C.reset} ${C.grey}${ev.reason}${C.reset}\n`,
      );
      break;
    }

    case "pay":
      console.log(
        `    ${C.blue}pay${C.reset}    ${fromMicro(ev.amountMicro)} ${sym} → ${ev.label}` +
          (ev.txid ? `  ${C.grey}${short(ev.txid, 12)}${C.reset}` : `  ${C.yellow}(not settled)${C.reset}`),
      );
      break;

    case "verify": {
      const failed = ev.checks.filter(c => !c.pass);
      const timing = `${C.grey}${(ev.latencyMs / 1000).toFixed(1)}s paid request incl. settlement${C.reset}`;
      if (ev.pass) {
        console.log(`    ${C.green}verify${C.reset} all six checks passed · ${timing}`);
      } else {
        console.log(`    ${C.red}verify${C.reset} ${failed.map(f => `${f.name}: ${f.detail}`).join(" · ")} · ${timing}`);
      }
      break;
    }

    case "claim":
      console.log(
        `    ${C.violet}CLAIM${C.reset}  refund ${fromMicro(ev.refundMicro)} + slash ${fromMicro(ev.slashMicro)} ${sym}` +
          ` · bond now ${fromMicro(ev.bondRemainingMicro)}`,
      );
      console.log(`           ${C.grey}${txUrl(ev.txid)}${C.reset}`);
      break;

    case "claim:error":
      console.log(`    ${C.red}claim failed${C.reset} ${ev.message}`);
      break;

    case "log":
      if (ev.level !== "info" || /switch|complete|record/i.test(ev.message)) {
        const colour = ev.level === "error" ? C.red : ev.level === "warn" ? C.yellow : C.grey;
        console.log(`  ${colour}${ev.message}${C.reset}`);
      }
      break;

    case "demo:end": {
      const s = ev.summary;
      console.log(`\n${bar()}`);
      console.log(`  ${C.bold}RESULT${C.reset}`);
      console.log(`    x402 calls paid       ${s.paid}`);
      console.log(`    verified good         ${C.green}${s.passed}${C.reset}`);
      console.log(`    SLA violations        ${C.red}${s.failed}${C.reset}`);
      console.log(`    claims upheld         ${C.violet}${s.claims}${C.reset}`);
      console.log(`    spent on calls        ${fromMicro(s.spentMicro)} ${env.assetSymbol}`);
      console.log(`    refunded from bonds   ${C.green}${fromMicro(s.refundedMicro)}${C.reset} ${env.assetSymbol}`);
      console.log(`    slashed to treasury   ${C.violet}${fromMicro(s.slashedMicro)}${C.reset} ${env.assetSymbol}`);
      if (s.routingSwitchedAt) {
        console.log(`    ${C.bold}routing switched at call ${s.routingSwitchedAt}${C.reset}`);
      }
      console.log(bar());
      for (const [addr, b] of Object.entries(s.byProvider)) {
        console.log(`    ${b.label.padEnd(20)} ${b.calls} calls · ${b.passed} good · ${b.failed} bad  ${C.grey}${short(addr, 8)}${C.reset}`);
      }
      console.log(bar());
      console.log(`  proof: ${baseUrl}/proof`);
      console.log(bar());
      break;
    }
  }
}

main().catch(err => {
  console.error(`\n${C.red}demo failed:${C.reset}`, err?.message ?? err);
  process.exit(1);
});
