/* Recourse dashboard.
   Reads the free endpoints for state and the SSE stream for live activity. */

const $ = id => document.getElementById(id);
const EXPLORER = "https://lora.algokit.io/testnet";
const txLink = t => `${EXPLORER}/transaction/${t}`;
const short = (s, n = 6) => (s ? `${s.slice(0, n)}…${s.slice(-4)}` : "—");
const fmt = (n, d = 3) => Number(n ?? 0).toFixed(d);

const state = {
  asset: "USDC",
  appId: null,
  exploreSamples: 10,
  bondBase: {},          // provider -> highest bond seen, for the drain bar
  run: { paid: 0, pass: 0, fail: 0, claims: 0, spent: 0, refund: 0, slash: 0, calls: 0, total: 0 },
  switched: false,
  adminKey: new URLSearchParams(location.search).get("key") || localStorage.getItem("recourse_key") || "",
};
if (state.adminKey) localStorage.setItem("recourse_key", state.adminKey);

const micro = m => Number(m ?? 0) / 1e6;

/* ---------------------------------------------------------------- boot ---- */

async function boot() {
  await Promise.all([loadHealth(), loadProviders(), loadRegistry(), loadClaims(), loadProof()]);
  connectEvents();
  setInterval(() => { loadProviders(); loadRegistry(); }, 6000);
  setInterval(loadProof, 20000);
  loadEcosystem();
  setInterval(loadEcosystem, 300000);
  setInterval(loadHealth, 15000);
}

async function j(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/* -------------------------------------------------------------- health ---- */

async function loadHealth() {
  try {
    const h = await j("/health");
    state.asset = h.asset.symbol;
    state.appId = h.app_id;
    const up = h.chain?.connected;
    $("dot-chain").className = `dot ${up ? "on" : "off"}`;
    $("chain-label").textContent = up ? `TestNet · round ${h.chain.last_round.toLocaleString()}` : "chain unreachable";
    $("pill-app").textContent = h.app_id ?? "not deployed";
    $("pill-asset").textContent = `${h.asset.symbol} · ${h.asset.id}`;
    if (h.agent) $("pill-agent").textContent = short(h.agent, 8);

    if (h.app_id) {
      const a = $("proof-app");
      a.textContent = `#${h.app_id}`;
      a.href = `${EXPLORER}/application/${h.app_id}`;
    }

    $("endpoints").innerHTML = `
      <div class="k">GET /score</div><div class="v">${fmt(h.price.score)} ${h.asset.symbol}</div>
      <div class="k">GET /feed/compliant</div><div class="v">${fmt(h.price.feed)} ${h.asset.symbol}</div>
      <div class="k">GET /feed/stale</div><div class="v">${fmt(h.price.feed)} ${h.asset.symbol}</div>
      <div class="k">Facilitator</div><div class="v">GoPlausible</div>
      <div class="k">Store</div><div class="v">${h.store}</div>`;

    const links = [];
    if (h.app_id) links.push(`<a href="${EXPLORER}/application/${h.app_id}" target="_blank" rel="noopener">app ${h.app_id} on Lora</a>`);
    if (h.repo) links.push(`<a href="${h.repo}" target="_blank" rel="noopener">source</a>`);
    links.push(`<a href="/proof" target="_blank" rel="noopener">proof</a>`);
    links.push(`<a href="/ecosystem" target="_blank" rel="noopener">ecosystem</a>`);
    $("foot-links").innerHTML = links.join(" · ");
  } catch { $("dot-chain").className = "dot off"; }
}

/* ----------------------------------------------------------- providers ---- */

async function loadProviders() {
  try {
    const d = await j("/providers");
    state.exploreSamples = d.explore_samples ?? 10;
    $("explore-note").textContent = `explores ${state.exploreSamples} calls before trusting a score`;
    renderProviders(d.providers);
  } catch { /* transient */ }
}

function renderProviders(list) {
  if (!list?.length) return;
  const el = $("providers");
  el.innerHTML = list.map(p => {
    const base = Math.max(state.bondBase[p.provider] ?? 0, p.bond_micro);
    state.bondBase[p.provider] = base;
    const pct = base > 0 ? Math.round((p.bond_micro / base) * 100) : 0;
    const dead = !p.active || p.bond_micro === 0;
    // The headline number must be the thing it is labelled: passes over samples.
    // p.reliability is the weighted composite and is a different quantity — it
    // lives in /score for agents, not on a card next to the word "pass rate".
    const passRate = p.samples ? Math.round((p.passes / p.samples) * 100) : 0;
    const low = Math.round((p.reliability_lower_bound ?? 0) * 100);
    // The bar shows the lower bound, because that is the number the agent acts
    // on. A wide bar with a low fill is exactly what "unmeasured" looks like.
    const relClass =
      p.recommendation === "unrated" ? "unrated" : low > 95 ? "good" : low > 60 ? "warn" : "bad";
    const bondClass = pct > 50 ? "good" : pct > 20 ? "warn" : "bad";
    return `
      <div class="pcard ${dead ? "dead" : ""}">
        <div class="pcard-top">
          <div style="min-width:0">
            <h3>${p.label}</h3>
            <div class="addr"><a href="${EXPLORER}/account/${p.provider}" target="_blank" rel="noopener">${short(p.provider, 8)}</a></div>
          </div>
          <span class="badge ${p.recommendation}">${p.recommendation}</span>
        </div>
        <div class="blurb">${p.blurb}</div>

        <div class="metric-row"><span>Bond</span><b>${fmt(p.bond)} ${state.asset}</b></div>
        <div class="track"><i class="${bondClass}" style="width:${pct}%"></i></div>

        <div class="metric-row"><span>Observed pass rate</span><b>${p.samples ? `${passRate}% (${p.passes}/${p.samples})` : "unmeasured"}</b></div>
        <div class="track"><i class="${relClass}" style="width:${p.samples ? low : 0}%"></i></div>
        <div class="metric-row" style="font-size:11px;margin-top:6px">
          <span>${p.recommendation === "unrated" ? "not yet conclusive" : "95% lower bound"} · ${p.confidence} confidence</span>
          <b>${p.samples ? `≥${low}%` : "—"}</b>
        </div>
        ${p.samples ? `
        <div class="metric-row" style="font-size:11px;margin-top:4px">
          <span title="Confidence is capped at medium while every observation comes from one payer. A thousand calls from a single counterparty is one relationship observed a thousand times, not a thousand independent observations.">${
            p.single_source
              ? "single source — confidence capped"
              : `${p.distinct_payers} independent payers`
          }</span>
          <b>${p.distinct_payers}</b>
        </div>` : ""}

        ${p.divergence !== null && p.divergence !== undefined ? `
        <div class="metric-row" style="font-size:11px;margin-top:6px">
          <span>${p.divergence_conclusive && p.divergence > 0.004
            ? "<b>disagrees with the market</b> — cannot be slashed"
            : "agrees with the market"}</span>
          <b>${(p.divergence * 100).toFixed(2)}%</b>
        </div>` : ""}

        <div class="pstats">
          <div class="pstat"><div class="n">${p.samples}</div><div class="l">samples</div></div>
          <div class="pstat"><div class="n" style="color:${p.claims ? "var(--bad)" : "inherit"}">${p.claims}</div><div class="l">claims</div></div>
          <div class="pstat"><div class="n">${dead ? "off" : "live"}</div><div class="l">status</div></div>
        </div>
      </div>`;
  }).join("");
}

/* ------------------------------------------------------------ registry ---- */

async function loadRegistry() {
  try {
    const r = await j("/registry");
    $("registry").innerHTML = `
      <div class="k">App ID</div><div class="v"><a href="${r.app_url}" target="_blank" rel="noopener">${r.app_id}</a></div>
      <div class="k">Providers</div><div class="v">${r.provider_count}</div>
      <div class="k">Total bonded</div><div class="v">${fmt(r.total_bonded)} ${state.asset}</div>
      <div class="k">Claims upheld <span class="faint">(cumulative)</span></div><div class="v">${r.claim_count}</div>
      <div class="k">Total slashed <span class="faint">(cumulative)</span></div><div class="v">${fmt(r.total_slashed)} ${state.asset}</div>
      <div class="k">Bonded <span class="faint">(live)</span></div><div class="v">${fmt(r.total_bonded)} ${state.asset}</div>
      <div class="k">x402 payments seen</div><div class="v">${r.x402_payments_observed}</div>
      <div class="k">x402 volume</div><div class="v">${fmt(r.x402_volume)} ${state.asset}</div>`;

    $("st-providers").textContent = r.provider_count;
    $("st-bonded").textContent = fmt(r.total_bonded);
    $("st-claims").textContent = r.claim_count;
    $("st-slashed").textContent = fmt(r.total_slashed);
    $("st-payments").textContent = r.x402_payments_observed;
  } catch {
    $("registry").innerHTML = `<div class="k">registry</div><div class="v">unavailable</div>`;
  }
}

/* -------------------------------------------------------------- claims ---- */

async function loadClaims() {
  try {
    const d = await j("/claims?limit=25");
    if (!d.claims.length) return;
    $("claims").innerHTML = d.claims.map(claimRow).join("");
    const first = d.claims[0];
    if (first?.txid) setProof("proof-claim", first.txid);
  } catch { /* transient */ }
}

function claimRow(c) {
  return `<div class="claim-row">
    <div class="top">
      <span>refund <span class="amt">${fmt(micro(c.refund_micro))}</span> · slash <span class="amt">${fmt(micro(c.slash_micro))}</span> ${state.asset}</span>
      <a href="${c.explorer}" target="_blank" rel="noopener">tx ↗</a>
    </div>
    <div class="meta">
      <span>${short(c.provider, 8)}</span>
      <span>${c.age_s}s stale</span>
      <span class="mono">${c.request_id.slice(0, 10)}…</span>
    </div>
  </div>`;
}

function setProof(id, txid) {
  const el = $(id);
  el.className = "v";
  el.innerHTML = `<a href="${txLink(txid)}" target="_blank" rel="noopener">${short(txid, 10)}</a>`;
}

/* ----------------------------------------------------------- ecosystem ---- */

async function loadEcosystem() {
  try {
    const d = await j("/ecosystem");
    $("eco-total").textContent = d.total;
    $("eco-bonded").textContent = d.bonded;
    $("eco-unbonded").textContent = d.unbonded;
    $("eco-updated").textContent = `${d.networks.map(n => `${n.label} ${n.count}`).join(" · ")}`;

    // Bonded first, then the busiest unbonded — the ones where the most money
    // has already moved with nothing standing behind it.
    const rows = [
      ...d.entries.filter(e => e.recourse.bonded),
      ...d.entries.filter(e => !e.recourse.bonded).slice(0, 10),
    ];
    $("eco-list").innerHTML = rows.map(e => {
      const host = e.url.replace(/^https?:\/\//, "");
      const tag = e.recourse.bonded
        ? `<span class="s bonded">covers ${e.recourse.coverage_calls}</span>`
        : `<span class="s none">no recourse</span>`;
      return `<div class="eco-row">
        <span class="u" title="${e.url}">${host}</span>
        <span class="n">${e.settle_count.toLocaleString()} settled${e.price !== null ? ` · $${e.price}` : ""}</span>
        ${tag}
      </div>`;
    }).join("");
  } catch {
    $("eco-list").innerHTML = `<div class="empty">Bazaar catalogue unavailable right now.</div>`;
  }
}

/* --------------------------------------------------------------- proof ---- */

async function loadProof() {
  try {
    const p = await j("/proof");
    const bond = Object.values(p.bond_deposited || {})[0];
    if (bond?.txid) setProof("proof-bond", bond.txid);
    if (p.x402_payment?.txid) setProof("proof-pay", p.x402_payment.txid);
    if (p.claim_upheld?.txid) setProof("proof-claim", p.claim_upheld.txid);
  } catch { /* proof.json may not exist yet */ }
}

/* -------------------------------------------------------------- events ---- */

function connectEvents() {
  const es = new EventSource("/events");
  es.onopen = () => { $("dot-sse").className = "dot on"; };
  es.onerror = () => { $("dot-sse").className = "dot off"; };
  es.onmessage = e => handle(JSON.parse(e.data));
  ["demo:start","demo:end","demo:error","score","route","pay","verify","claim","claim:error","provider:update","log"]
    .forEach(t => es.addEventListener(t, e => handle(JSON.parse(e.data))));
}

const seen = new Set();
function handle(ev) {
  const key = `${ev.type}:${ev.at}:${ev.index ?? ""}:${ev.provider ?? ""}:${ev.message ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 3000) seen.clear();

  switch (ev.type) {
    case "demo:start":   onDemoStart(ev); break;
    case "demo:end":     onDemoEnd(ev); break;
    case "demo:error":   feed("fail", "Demo failed", ev.message); setRunning(false); break;
    case "route":        onRoute(ev); break;
    case "pay":          onPay(ev); break;
    case "verify":       onVerify(ev); break;
    case "claim":        onClaim(ev); break;
    case "claim:error":
      flowSet("claim", "bad", `rejected<br><span style="opacity:.75">${ev.message}</span>`);
      feed("fail", "Claim rejected", ev.message);
      break;
    case "provider:update": loadProviders(); break;
    case "log":          if (ev.level !== "info" || /switch|routing|record|complete/i.test(ev.message)) feed("info", ev.message); break;
  }
}

/* ----------------------------------------------------------- flow panel ---- */

/**
 * The live workflow. One purchase at a time, so a viewer can follow a single
 * story rather than watch seven stages of forty calls interleave.
 *
 * Stages are never hidden, only dimmed — someone reading mid-run should be able
 * to see what is about to happen, not just what already did.
 */
const flowStep = name => document.querySelector(`.flow .step[data-step="${name}"]`);

/** Passing no value keeps whatever the stage already showed, so advancing a
 *  stage from active to done does not erase what it told the reader. */
function flowSet(name, state, value) {
  const el = flowStep(name);
  if (!el) return;
  el.classList.remove("done", "active", "bad", "skip");
  if (state) el.classList.add(state);
  if (value !== undefined) el.querySelector(".v").innerHTML = value;
}

function flowReset() {
  for (const name of ["survey", "route", "policy", "pay", "settle", "verify", "claim"]) {
    flowSet(name, null, "");
  }
  $("flow-checks").innerHTML = "";
}

function onDemoStart(ev) {
  state.run = { paid: 0, pass: 0, fail: 0, claims: 0, spent: 0, refund: 0, slash: 0, calls: 0, total: ev.calls };
  state.switched = false;
  $("route-banner").className = "route-banner";
  $("routing").className = "card";
  renderStats();
  setRunning(true);
  state.surveyPaid = 0;
  state.surveySpent = 0;
  flowReset();
  flowSet("survey", "active", "buying risk records…");
  $("flow-note").textContent =
    "Live. Each stage fills in as it happens; stage 7 only fires when a provider is caught.";
  feed("info", `Agent starting ${ev.calls} x402 calls on Algorand TestNet`);
}

function onDemoEnd(ev) {
  $("flow-call").textContent = `finished — ${ev.summary.calls ?? state.run.total} calls`;
  $("flow-note").innerHTML =
    `Run complete. <b>${ev.summary.paid}</b> paid, <b>${ev.summary.passed}</b> verified good, ` +
    `<b>${ev.summary.failed}</b> violations, <b>${ev.summary.claims}</b> settled out of a provider's bond.`;
  setRunning(false);
  $("progress").style.width = "100%";
  const s = ev.summary;
  feed("info",
    `Run complete — ${s.paid} paid, ${s.passed} verified good, ${s.failed} violations, ${s.claims} claims upheld`);
  loadProviders(); loadRegistry(); loadClaims();
}

function onRoute(ev) {
  state.run.calls = ev.index;
  // A new call begins: stage 1 is settled history, everything after it is fresh.
  $("flow-call").textContent = `call ${ev.index} of ${state.run.total}`;
  flowSet("survey", "done");
  const excluded = ev.candidates.filter(c => !c.eligible).length;
  flowSet("route", "active",
    `${ev.chosenLabel}${excluded ? `<br><span style="opacity:.7">${excluded} excluded</span>` : ""}`);
  flowSet("policy", null, "");
  flowSet("pay", null, "");
  flowSet("settle", null, "");
  flowSet("verify", null, "");
  flowSet("claim", null, "");
  $("flow-checks").innerHTML = "";
  $("progress").style.width = `${Math.min(100, (ev.index / Math.max(1, state.run.total)) * 100)}%`;
  $("route-note").style.display = "flex";
  $("route-idx").textContent = ev.index;
  $("route-reason").textContent = ev.reason;

  $("lanes").innerHTML = ev.candidates.map(c => {
    const chosen = c.provider === ev.chosen;
    const cls = !c.eligible ? "excluded" : chosen ? "eligible chosen" : "eligible";
    const verdict = !c.eligible
      ? `<span class="verdict out">excluded</span>`
      : chosen ? `<span class="verdict now">buying now</span>` : `<span class="verdict in">eligible</span>`;
    return `<div class="lane ${cls}">
      <div style="min-width:0">
        <div class="name">${c.label}</div>
        <div class="why">${c.reason}</div>
      </div>
      ${verdict}
    </div>`;
  }).join("");

  // The moment the pitch turns on: a provider drops out of routing for good.
  const dropped = ev.candidates.find(c => !c.eligible);
  if (dropped && !state.switched) {
    state.switched = true;
    $("routing").className = "card switched";
    const b = $("route-banner");
    $("route-banner-text").textContent =
      `Routing switched at call ${ev.index} — ${dropped.label} is out: ${dropped.reason}. The agent will not pay it again.`;
    b.className = "route-banner show";
    feed("route", `Routing switched — ${dropped.label} excluded`, dropped.reason);
  }
}

function onPay(ev) {
  // The agent buys risk data before it buys anything else, and both are real
  // x402 payments. A survey purchase belongs to stage 1, not to the current
  // call's payment — routing it through the stages below would overwrite them
  // with another call's details and make one story impossible to follow.
  if (ev.kind === "survey") {
    state.surveyPaid = (state.surveyPaid ?? 0) + (ev.settled ? 1 : 0);
    state.surveySpent = (state.surveySpent ?? 0) + (ev.settled ? ev.amountMicro : 0);
    flowSet("survey", "active",
      `${state.surveyPaid} bought · ${fmt(micro(state.surveySpent))} ${state.asset}`);
    onPayBookkeeping(ev);
    return;
  }

  // Stage 3: the agent read the 402 before building anything. A refusal here is
  // the control working, so it is shown as a red stop rather than a failure.
  if (ev.refused) {
    flowSet("route", "done");
    flowSet("policy", "bad", `refused<br><span style="opacity:.75">${ev.refusedReason || "402 did not match"}</span>`);
    flowSet("pay", "skip", "no transaction built");
    flowSet("settle", "skip", "—");
    return;
  }
  flowSet("route", "done");
  flowSet("policy", "done", "payee · asset · network · price ✓");

  if (ev.settled) {
    flowSet("pay", "done",
      `${fmt(micro(ev.amountMicro))} ${state.asset}` +
      (ev.latencyMs ? `<br><span style="opacity:.7">${(ev.latencyMs / 1000).toFixed(1)}s</span>` : "") +
      (ev.txid ? `<br><a href="${txLink(ev.txid)}" target="_blank" rel="noopener">${short(ev.txid, 8)}</a>` : ""));
    // Stage 5 is the one that matters: the facilitator said it settled, and the
    // agent went and looked.
    if (ev.settlementVerified === true) {
      flowSet("settle", "done", "confirmed on chain ✓");
    } else if (ev.settlementVerified === false) {
      flowSet("settle", "bad", `unconfirmed<br><span style="opacity:.75">${ev.settlementReason || ""}</span>`);
    } else {
      flowSet("settle", "skip", "not checked");
    }
    flowSet("verify", "active", "running six checks…");
  } else {
    flowSet("pay", "bad", "did not settle");
    flowSet("settle", "skip", "—");
  }

  onPayBookkeeping(ev);
}

/** Run totals and the feed row. Every settled payment counts, survey or not. */
function onPayBookkeeping(ev) {
  if (ev.settled) {
    state.run.paid++;
    state.run.spent += ev.amountMicro;
    if ($("proof-pay").className.includes("pending")) setProof("proof-pay", ev.txid);
  }
  renderStats();
  const link = ev.txid ? ` <a href="${txLink(ev.txid)}" target="_blank" rel="noopener">${short(ev.txid, 8)}</a>` : " (not settled)";
  feed("pay", `Paid ${fmt(micro(ev.amountMicro))} ${state.asset} → ${ev.label}`,
       `${ev.resource.replace(/^https?:\/\/[^/]+/, "")}${link}`, ev.index);
}

function onVerify(ev) {
  if (ev.pass) state.run.pass++; else state.run.fail++;
  renderStats();

  const failed = ev.checks.filter(c => !c.pass);
  flowSet("verify", ev.pass ? "done" : "bad",
    ev.pass ? `${ev.checks.length}/${ev.checks.length} passed`
            : `${failed.map(c => c.name).join(", ")}`);
  $("flow-checks").innerHTML =
    ev.checks.map(c => `<span class="chk ${c.pass ? "ok" : "no"}">${c.name}</span>`).join("");
  // A pass means stage 7 is deliberately not reached, which is the good
  // outcome — say so rather than leaving it blank and ambiguous.
  if (ev.pass) flowSet("claim", "skip", "nothing to claim");
  else flowSet("claim", "active", "filing proof on chain…");
  const chips = ev.checks.map(c => `<span class="chk ${c.pass ? "ok" : "no"}">${c.name}</span>`).join("");
  const timing = `${(ev.latencyMs / 1000).toFixed(1)}s paid request incl. settlement · ${(ev.totalMs / 1000).toFixed(1)}s full exchange`;
  const detail = ev.pass
    ? `all six checks passed · ${timing}`
    : `${ev.checks.filter(c => !c.pass).map(c => c.detail).join(" · ")} · ${timing}`;
  feed(ev.pass ? "pass" : "fail", `${ev.pass ? "Verified" : "SLA violation"} — ${ev.label}`,
       `${detail}<div class="checks">${chips}</div>`, ev.index);
}

function onClaim(ev) {
  flowSet("claim", "done",
    `+${fmt(micro(ev.refundMicro))} refund<br>−${fmt(micro(ev.slashMicro))} slashed` +
    `<br><a href="${txLink(ev.txid)}" target="_blank" rel="noopener">${short(ev.txid, 8)}</a>`);
  state.run.claims++;
  state.run.refund += ev.refundMicro;
  state.run.slash += ev.slashMicro;
  renderStats();
  setProof("proof-claim", ev.txid);
  feed("claim", `Claim upheld — ${fmt(micro(ev.refundMicro))} refunded, ${fmt(micro(ev.slashMicro))} slashed`,
       `${ev.label} signed data ${ev.ageS}s old · bond now ${fmt(micro(ev.bondRemainingMicro))} ${state.asset} · <a href="${txLink(ev.txid)}" target="_blank" rel="noopener">${short(ev.txid, 8)}</a>`);
  loadClaims(); loadProviders();
}

/* ---------------------------------------------------------------- view ---- */

function renderStats() {
  const r = state.run;
  $("s-paid").textContent = r.paid;
  $("s-pass").textContent = r.pass;
  $("s-fail").textContent = r.fail;
  $("s-claims").textContent = r.claims;
  $("s-spent").textContent = `${fmt(micro(r.spent))} ${state.asset}`;
  $("s-refund").textContent = `${fmt(micro(r.refund))} ${state.asset}`;
  $("s-slash").textContent = `${fmt(micro(r.slash))} ${state.asset}`;
}

let feedCount = 0;
function feed(tag, title, detail = "", index) {
  const el = $("feed");
  if (feedCount === 0) el.innerHTML = "";
  feedCount++;
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `
    <div class="idx">${index ?? ""}</div>
    <div class="msg"><span class="t">${title}</span>${detail ? `<span class="d">${detail}</span>` : ""}</div>
    <span class="tag ${tag}">${tag}</span>`;
  el.prepend(row);
  while (el.children.length > 160) el.removeChild(el.lastChild);
}

function setRunning(on) {
  const b = $("run");
  b.disabled = on;
  b.innerHTML = on ? `<span class="spin"></span> agent running…` : "Start the agent";
  $("calls").disabled = on;
}

/* ------------------------------------------------------------ controls ---- */

$("run").addEventListener("click", async () => {
  let key = state.adminKey;
  if (!key) {
    key = prompt("Admin key (ADMIN_KEY from .env):") || "";
    if (!key) return;
    state.adminKey = key;
    localStorage.setItem("recourse_key", key);
  }
  const calls = Number($("calls").value || 30);
  setRunning(true);
  try {
    const r = await fetch("/admin/demo", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": key },
      body: JSON.stringify({ calls }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      if (r.status === 401) { localStorage.removeItem("recourse_key"); state.adminKey = ""; }
      feed("fail", "Could not start the agent", e.error || r.statusText);
      setRunning(false);
    }
  } catch (err) {
    feed("fail", "Could not start the agent", String(err));
    setRunning(false);
  }
});

$("clear").addEventListener("click", () => {
  $("feed").innerHTML = `<div class="empty">Cleared.</div>`;
  feedCount = 0;
});

boot();
