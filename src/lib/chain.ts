/**
 * Everything that touches Algorand: deploying the Recourse app, calling its ABI
 * methods, and reading provider state straight out of box storage.
 *
 * Box reads are done raw rather than through a simulate call. The Provider
 * struct is fixed width by design, so decoding it is 20 lines and costs nothing.
 */
import algosdk from "algosdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../env.ts";

// ------------------------------------------------------------------- clients

let _algod: algosdk.Algodv2 | null = null;
export function algod(): algosdk.Algodv2 {
  if (!_algod) _algod = new algosdk.Algodv2(env.algodToken, env.algodUrl, "");
  return _algod;
}

// ------------------------------------------------------------------ app spec

export type Arc56Method = {
  name: string;
  args: { type: string; name?: string }[];
  returns: { type: string };
};
export type Arc56Spec = {
  name: string;
  methods: Arc56Method[];
  source?: { approval: string; clear: string };
  state: {
    schema: {
      global: { ints: number; bytes: number };
      local: { ints: number; bytes: number };
    };
    keys?: { global?: Record<string, { key: string; valueType: string }> };
  };
};

const SPEC_PATH = resolve(process.cwd(), "contracts/build/Recourse.arc56.json");

let _spec: Arc56Spec | null = null;
export function spec(): Arc56Spec {
  if (!_spec) _spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as Arc56Spec;
  return _spec;
}

export function abiMethod(name: string): algosdk.ABIMethod {
  const m = spec().methods.find(x => x.name === name);
  if (!m) throw new Error(`Method not in app spec: ${name}`);
  return new algosdk.ABIMethod({
    name: m.name,
    args: m.args.map(a => ({ type: a.type, name: a.name })),
    returns: { type: m.returns.type },
  });
}

/** TEAL source, stored base64 in the ARC-56 file. */
export function tealSource(): { approval: string; clear: string } {
  const s = spec().source;
  if (!s) throw new Error("ARC-56 spec has no embedded source; recompile with --output-arc56");
  return {
    approval: Buffer.from(s.approval, "base64").toString("utf8"),
    clear: Buffer.from(s.clear, "base64").toString("utf8"),
  };
}

let _indexer: algosdk.Indexer | null = null;
export function indexer(): algosdk.Indexer {
  if (!_indexer) _indexer = new algosdk.Indexer("", env.indexerUrl, "");
  return _indexer;
}

export type SettlementCheck = {
  verified: boolean;
  reason: string;
  confirmedRound?: number;
  amountMicro?: number;
  sender?: string;
  receiver?: string;
};

/**
 * Confirm on chain that a settlement the facilitator reported actually happened,
 * and happened as described.
 *
 * A facilitator is a third party in the payment path. Taking its word that money
 * moved is exactly the trust assumption this project exists to remove: a
 * compromised or buggy one could report a settlement that never occurred, or one
 * that paid a different address or a smaller amount, and nothing downstream
 * would notice. The transaction id it returns is checkable, so we check it.
 *
 * Tries algod first — a just-settled transaction is still in its recent cache —
 * and falls back to the indexer, which lags by a round or two.
 *
 * The two sources describe the same transaction with different field names, and
 * conflating them is a quiet way to get this wrong: algod returns a decoded
 * algosdk Transaction (`type`, `assetTransfer.assetIndex`) while the indexer
 * returns its own REST shape (`txType`, `assetTransferTransaction.assetId`).
 * Reading indexer names off an algod response yields `undefined` rather than an
 * error, so the check does not fail loudly — it reports "not an asset transfer"
 * about a perfectly good payment. Both shapes are normalised here, once.
 */
export type NormalisedTxn = {
  type: string;
  sender: string;
  receiver: string;
  assetId: number;
  amountMicro: number;
  confirmedRound?: number;
};

/** algod: a decoded algosdk Transaction plus the confirming round. */
export function normaliseAlgodTxn(res: unknown): NormalisedTxn | null {
  const r = res as {
    txn?: { txn?: Record<string, unknown> };
    confirmedRound?: unknown;
  };
  const inner = r?.txn?.txn;
  if (!inner) return null;
  const at = inner.assetTransfer as
    | { amount?: unknown; receiver?: unknown; assetIndex?: unknown }
    | undefined;
  return {
    type: String(inner.type ?? ""),
    sender: String(inner.sender ?? ""),
    receiver: String(at?.receiver ?? ""),
    assetId: Number(at?.assetIndex ?? 0),
    amountMicro: Number(at?.amount ?? 0),
    confirmedRound: Number(r.confirmedRound ?? 0) || undefined,
  };
}

/** indexer: the REST representation, which trails the chain slightly. */
export function normaliseIndexerTxn(res: unknown): NormalisedTxn | null {
  const t = (res as { transaction?: Record<string, unknown> })?.transaction;
  if (!t) return null;
  const at = t.assetTransferTransaction as
    | { amount?: unknown; receiver?: unknown; assetId?: unknown }
    | undefined;
  return {
    type: String(t.txType ?? ""),
    sender: String(t.sender ?? ""),
    receiver: String(at?.receiver ?? ""),
    assetId: Number(at?.assetId ?? 0),
    amountMicro: Number(at?.amount ?? 0),
    confirmedRound: Number(t.confirmedRound ?? 0) || undefined,
  };
}

export async function verifySettlement(
  txid: string,
  expect: { sender?: string; receiver?: string; assetId?: number; amountMicro?: number },
  attempts = 3,
): Promise<SettlementCheck> {
  let txn: NormalisedTxn | null = null;

  for (let i = 0; i < attempts && !txn; i++) {
    // Each source is tried on its own merits. Nesting the indexer inside the
    // algod catch made it unreachable whenever algod answered — which is the
    // common case for a payment that just settled.
    try {
      txn = normaliseAlgodTxn(await algod().pendingTransactionInformation(txid).do());
    } catch {
      // Outside algod's recent-transaction window, or not yet visible.
    }
    if (!txn) {
      try {
        txn = normaliseIndexerTxn(await indexer().lookupTransactionByID(txid).do());
      } catch {
        // The indexer trails the chain by a round or two.
      }
    }
    if (!txn && i < attempts - 1) await new Promise(r => setTimeout(r, 1200));
  }

  if (!txn) return { verified: false, reason: "transaction not found on chain" };
  if (txn.type !== "axfer") {
    return { verified: false, reason: `not an asset transfer (${txn.type || "unknown"})` };
  }

  const { amountMicro: amount, receiver, sender, assetId } = txn;
  const found: SettlementCheck = {
    verified: false, reason: "", amountMicro: amount, sender, receiver,
    confirmedRound: txn.confirmedRound,
  };

  if (expect.assetId !== undefined && assetId !== expect.assetId) {
    return { ...found, reason: `asset ${assetId} is not ${expect.assetId}` };
  }
  if (expect.receiver && receiver !== expect.receiver) {
    return { ...found, reason: `paid ${receiver.slice(0, 10)}… not ${expect.receiver.slice(0, 10)}…` };
  }
  if (expect.sender && sender !== expect.sender) {
    return { ...found, reason: `sent by ${sender.slice(0, 10)}… not ${expect.sender.slice(0, 10)}…` };
  }
  if (expect.amountMicro !== undefined && amount !== expect.amountMicro) {
    return { ...found, reason: `moved ${amount} not ${expect.amountMicro}` };
  }
  return { ...found, verified: true, reason: "matches the advertised terms" };
}

// ------------------------------------------------------------------- helpers

export function signerFor(account: algosdk.Account): algosdk.TransactionSigner {
  return algosdk.makeBasicAccountTransactionSigner(account);
}

export function providerBoxName(address: string): Uint8Array {
  return new Uint8Array([
    ...Buffer.from("p_", "utf8"),
    ...algosdk.decodeAddress(address).publicKey,
  ]);
}

export function claimBoxName(requestId: Buffer): Uint8Array {
  return new Uint8Array([...Buffer.from("c_", "utf8"), ...requestId]);
}

async function params(fee?: number): Promise<algosdk.SuggestedParams> {
  const sp = await algod().getTransactionParams().do();
  if (fee !== undefined) {
    sp.fee = BigInt(fee);
    sp.flatFee = true;
  }
  return sp;
}

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return new Uint8Array(Buffer.from(v, "base64"));
  return new Uint8Array();
}

// -------------------------------------------------------------------- deploy

export async function compilePrograms(): Promise<{ approval: Uint8Array; clear: Uint8Array }> {
  const src = tealSource();
  const a = await algod().compile(src.approval).do();
  const c = await algod().compile(src.clear).do();
  return {
    approval: new Uint8Array(Buffer.from(a.result, "base64")),
    clear: new Uint8Array(Buffer.from(c.result, "base64")),
  };
}

export async function deployApp(
  deployer: algosdk.Account,
  assetId: number,
): Promise<{ appId: number; appAddress: string; txid: string }> {
  const { approval, clear } = await compilePrograms();
  // 2048 bytes per program page; page 0 comes free with the app.
  const extraPages = Math.min(3, Math.max(0, Math.ceil(approval.length / 2048) - 1));
  const s = spec().state.schema;

  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: 0,
    method: abiMethod("create"),
    methodArgs: [assetId],
    sender: deployer.addr.toString(),
    signer: signerFor(deployer),
    suggestedParams: await params(),
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    approvalProgram: approval,
    clearProgram: clear,
    numGlobalInts: s.global.ints,
    numGlobalByteSlices: s.global.bytes,
    numLocalInts: s.local.ints,
    numLocalByteSlices: s.local.bytes,
    extraPages,
  });

  const res = await atc.execute(algod(), 6);
  const confirmed = await algod().pendingTransactionInformation(res.txIDs[0]).do();
  const appId = Number(confirmed.applicationIndex);
  return {
    appId,
    appAddress: algosdk.getApplicationAddress(appId).toString(),
    txid: res.txIDs[0],
  };
}

export async function fundAccount(
  from: algosdk.Account,
  to: string,
  microAlgos: number,
  note?: string,
): Promise<string> {
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: from.addr.toString(),
    receiver: to,
    amount: microAlgos,
    suggestedParams: await params(),
    note: note ? new Uint8Array(Buffer.from(note, "utf8")) : undefined,
  });
  const signed = txn.signTxn(from.sk);
  const { txid } = await algod().sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod(), txid, 6);
  return txid;
}

/** Opt an ordinary account into the payment/bond asset. Idempotent. */
export async function optInAsset(
  account: algosdk.Account,
  assetId: number,
): Promise<string | null> {
  const info = await accountInfo(account.addr.toString());
  if (info.assets.some(a => a.assetId === assetId)) return null;
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr.toString(),
    receiver: account.addr.toString(),
    amount: 0,
    assetIndex: assetId,
    suggestedParams: await params(),
  });
  const signed = txn.signTxn(account.sk);
  const { txid } = await algod().sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod(), txid, 6);
  return txid;
}

export async function sendAsset(
  from: algosdk.Account,
  to: string,
  assetId: number,
  amount: number,
): Promise<string> {
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: from.addr.toString(),
    receiver: to,
    amount,
    assetIndex: assetId,
    suggestedParams: await params(),
  });
  const signed = txn.signTxn(from.sk);
  const { txid } = await algod().sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod(), txid, 6);
  return txid;
}

// ---------------------------------------------------------------- app methods

export async function appOptInAsset(
  deployer: algosdk.Account,
  appId: number,
  assetId: number,
): Promise<string> {
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    method: abiMethod("opt_in_asset"),
    methodArgs: [],
    sender: deployer.addr.toString(),
    signer: signerFor(deployer),
    suggestedParams: await params(3000), // outer + inner axfer, with headroom
    appForeignAssets: [assetId],
  });
  const res = await atc.execute(algod(), 6);
  return res.txIDs[0];
}

export async function registerProvider(
  provider: algosdk.Account,
  opts: {
    appId: number;
    pubkey: Buffer;
    slaHash: Buffer;
    priceMicro: number;
    maxStaleness: number;
    maxLatencyMs: number;
  },
): Promise<string> {
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: opts.appId,
    method: abiMethod("register"),
    methodArgs: [
      Array.from(opts.pubkey),
      Array.from(opts.slaHash),
      opts.priceMicro,
      opts.maxStaleness,
      opts.maxLatencyMs,
    ],
    sender: provider.addr.toString(),
    signer: signerFor(provider),
    suggestedParams: await params(2000),
    boxes: [{ appIndex: opts.appId, name: providerBoxName(provider.addr.toString()) }],
  });
  const res = await atc.execute(algod(), 6);
  return res.txIDs[0];
}

export async function depositBond(
  provider: algosdk.Account,
  opts: { appId: number; assetId: number; amountMicro: number },
): Promise<{ txid: string; bondMicro: number }> {
  const appAddress = algosdk.getApplicationAddress(opts.appId).toString();
  const axfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: provider.addr.toString(),
    receiver: appAddress,
    amount: opts.amountMicro,
    assetIndex: opts.assetId,
    suggestedParams: await params(),
  });

  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: opts.appId,
    method: abiMethod("deposit_bond"),
    methodArgs: [{ txn: axfer, signer: signerFor(provider) }],
    sender: provider.addr.toString(),
    signer: signerFor(provider),
    suggestedParams: await params(2000),
    appForeignAssets: [opts.assetId],
    boxes: [{ appIndex: opts.appId, name: providerBoxName(provider.addr.toString()) }],
  });
  const res = await atc.execute(algod(), 6);
  return {
    txid: res.txIDs[res.txIDs.length - 1],
    bondMicro: Number(res.methodResults[0]?.returnValue ?? 0),
  };
}

/**
 * File a claim.
 *
 * Padded with two no-op app calls so the group pools 3 x 700 = 2100 units of
 * opcode budget. ed25519verify_bare alone costs 1900 against a 700 default, so
 * an unpadded call would fail. The contract also calls ensure_budget, which
 * covers any caller that forgets the padding.
 */
export async function submitClaim(
  payer: algosdk.Account,
  opts: {
    appId: number;
    assetId: number;
    provider: string;
    treasury: string;
    requestId: Buffer;
    responseHash: Buffer;
    dataTimestamp: number;
    signature: Buffer;
  },
): Promise<{ txid: string; refundMicro: number; groupTxIds: string[] }> {
  const atc = new algosdk.AtomicTransactionComposer();
  const sender = payer.addr.toString();
  const signer = signerFor(payer);

  for (let i = 0; i < 2; i++) {
    atc.addMethodCall({
      appID: opts.appId,
      method: abiMethod("noop"),
      methodArgs: [],
      sender,
      signer,
      suggestedParams: await params(0),
      // Distinct notes, or the two padding calls would collide on txid.
      note: new Uint8Array(Buffer.from(`recourse-opup-${i}`, "utf8")),
    });
  }

  atc.addMethodCall({
    appID: opts.appId,
    method: abiMethod("submit_claim"),
    methodArgs: [
      opts.provider,
      new Uint8Array(opts.requestId),
      new Uint8Array(opts.responseHash),
      opts.dataTimestamp,
      new Uint8Array(opts.signature),
    ],
    sender,
    signer,
    // Fee-pooled across the group: 3 outer + up to 2 inner axfers + headroom.
    suggestedParams: await params(10_000),
    appForeignAssets: [opts.assetId],
    appAccounts: [opts.provider, opts.treasury],
    boxes: [
      { appIndex: opts.appId, name: providerBoxName(opts.provider) },
      { appIndex: opts.appId, name: claimBoxName(opts.requestId) },
    ],
  });

  const res = await atc.execute(algod(), 6);
  const last = res.methodResults[res.methodResults.length - 1];
  return {
    txid: res.txIDs[res.txIDs.length - 1],
    refundMicro: Number(last?.returnValue ?? 0),
    groupTxIds: res.txIDs,
  };
}

export async function withdrawBond(
  provider: algosdk.Account,
  opts: { appId: number; assetId: number; amountMicro: number },
): Promise<string> {
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: opts.appId,
    method: abiMethod("withdraw_bond"),
    methodArgs: [opts.amountMicro],
    sender: provider.addr.toString(),
    signer: signerFor(provider),
    suggestedParams: await params(3000),
    appForeignAssets: [opts.assetId],
    boxes: [{ appIndex: opts.appId, name: providerBoxName(provider.addr.toString()) }],
  });
  const res = await atc.execute(algod(), 6);
  return res.txIDs[0];
}

export async function requestUnbond(
  provider: algosdk.Account,
  appId: number,
): Promise<{ txid: string; unbondAt: number }> {
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    method: abiMethod("request_unbond"),
    methodArgs: [],
    sender: provider.addr.toString(),
    signer: signerFor(provider),
    suggestedParams: await params(2000),
    boxes: [{ appIndex: appId, name: providerBoxName(provider.addr.toString()) }],
  });
  const res = await atc.execute(algod(), 6);
  return { txid: res.txIDs[0], unbondAt: Number(res.methodResults[0]?.returnValue ?? 0) };
}

export async function deregisterProvider(
  provider: algosdk.Account,
  appId: number,
): Promise<string> {
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    method: abiMethod("deregister"),
    methodArgs: [],
    sender: provider.addr.toString(),
    signer: signerFor(provider),
    suggestedParams: await params(2000),
    boxes: [{ appIndex: appId, name: providerBoxName(provider.addr.toString()) }],
  });
  const res = await atc.execute(algod(), 6);
  return res.txIDs[0];
}

export async function pruneClaim(
  sender: algosdk.Account,
  appId: number,
  requestId: Buffer,
): Promise<string> {
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    method: abiMethod("prune_claim"),
    methodArgs: [new Uint8Array(requestId)],
    sender: sender.addr.toString(),
    signer: signerFor(sender),
    suggestedParams: await params(2000),
    boxes: [{ appIndex: appId, name: claimBoxName(requestId) }],
  });
  const res = await atc.execute(algod(), 6);
  return res.txIDs[0];
}

/** Lists every box the app holds, so a teardown knows what to clear first. */
export async function listBoxes(appId: number): Promise<Uint8Array[]> {
  const res = await algod().getApplicationBoxes(appId).do();
  return (res.boxes ?? []).map(b => toBytes(b.name));
}

/**
 * Every address currently registered, read from the box names in one call.
 *
 * Cheaper and more honest than probing each candidate: the registry is exactly
 * the set of `p_`-prefixed boxes, so this cannot drift from what the contract
 * actually holds.
 */
export async function listRegisteredProviders(appId: number): Promise<string[]> {
  const names = await listBoxes(appId);
  const out: string[] = [];
  for (const name of names) {
    if (name.length !== 34) continue;
    if (name[0] !== 0x70 || name[1] !== 0x5f) continue; // "p_"
    out.push(algosdk.encodeAddress(name.subarray(2)));
  }
  return out;
}

export async function destroyApp(
  deployer: algosdk.Account,
  appId: number,
  assetId: number,
): Promise<string> {
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    method: abiMethod("destroy"),
    methodArgs: [],
    sender: deployer.addr.toString(),
    signer: signerFor(deployer),
    suggestedParams: await params(4000), // outer + asset close + algo close
    onComplete: algosdk.OnApplicationComplete.DeleteApplicationOC,
    appForeignAssets: [assetId],
  });
  const res = await atc.execute(algod(), 6);
  return res.txIDs[0];
}

export async function recordSuccess(
  deployer: algosdk.Account,
  opts: { appId: number; provider: string; count: number },
): Promise<string> {
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: opts.appId,
    method: abiMethod("record_success"),
    methodArgs: [opts.provider, opts.count],
    sender: deployer.addr.toString(),
    signer: signerFor(deployer),
    suggestedParams: await params(2000),
    boxes: [{ appIndex: opts.appId, name: providerBoxName(opts.provider) }],
  });
  const res = await atc.execute(algod(), 6);
  return res.txIDs[0];
}

// ---------------------------------------------------------------------- reads

export type ProviderState = {
  address: string;
  pubkey: Buffer;
  slaHash: Buffer;
  priceMicro: number;
  maxStaleness: number;
  maxLatencyMs: number;
  bondMicro: number;
  successCount: number;
  claimCount: number;
  slashedMicro: number;
  /** 0 while bonded; otherwise the unix time withdrawal unlocks. */
  unbondAt: number;
  active: boolean;
};

/** Provider is a fixed-width ARC-4 struct: 32 + 32 + 8*8 + 1 = 129 bytes. */
export function decodeProvider(address: string, raw: Uint8Array): ProviderState {
  const b = Buffer.from(raw);
  if (b.length < 129) throw new Error(`provider box too short: ${b.length} bytes`);
  const u64 = (off: number) => Number(b.readBigUInt64BE(off));
  return {
    address,
    pubkey: b.subarray(0, 32),
    slaHash: b.subarray(32, 64),
    priceMicro: u64(64),
    maxStaleness: u64(72),
    maxLatencyMs: u64(80),
    bondMicro: u64(88),
    successCount: u64(96),
    claimCount: u64(104),
    slashedMicro: u64(112),
    unbondAt: u64(120),
    // ARC-4 packs a trailing bool into one byte, value in the high bit.
    active: (b[128] & 0x80) !== 0,
  };
}

export async function readProvider(
  appId: number,
  address: string,
): Promise<ProviderState | null> {
  try {
    const box = await algod().getApplicationBoxByName(appId, providerBoxName(address)).do();
    return decodeProvider(address, toBytes(box.value));
  } catch (err: unknown) {
    const msg = String((err as Error)?.message ?? err);
    if (msg.includes("box not found") || msg.includes("404")) return null;
    throw err;
  }
}

export type GlobalStateView = {
  assetId: number;
  treasury: string;
  providerCount: number;
  claimCount: number;
  totalBonded: number;
  totalSlashed: number;
};

/**
 * ARC-56 field names are not the on-chain key bytes — `provider_count` is stored
 * under the key "providers". Resolving names through the spec means renaming a
 * field in the contract can never silently zero out a dashboard number.
 */
function globalKeyBytes(name: string): string {
  const entry = spec().state.keys?.global?.[name];
  return entry ? Buffer.from(entry.key, "base64").toString("utf8") : name;
}

export async function readGlobalState(appId: number): Promise<GlobalStateView> {
  const app = await algod().getApplicationByID(appId).do();
  const entries = (app.params?.globalState ?? []) as unknown as {
    key: unknown;
    value: { bytes: unknown; uint: unknown };
  }[];
  const map = new Map<string, { bytes: Uint8Array; uint: number }>();
  for (const e of entries) {
    map.set(Buffer.from(toBytes(e.key)).toString("utf8"), {
      bytes: toBytes(e.value.bytes),
      uint: Number(e.value.uint ?? 0),
    });
  }
  const get = (name: string) => map.get(globalKeyBytes(name));
  const treasuryBytes = get("treasury")?.bytes ?? new Uint8Array(0);
  return {
    assetId: get("asset_id")?.uint ?? 0,
    treasury: treasuryBytes.length === 32 ? algosdk.encodeAddress(treasuryBytes) : "",
    providerCount: get("provider_count")?.uint ?? 0,
    claimCount: get("claim_count")?.uint ?? 0,
    totalBonded: get("total_bonded")?.uint ?? 0,
    totalSlashed: get("total_slashed")?.uint ?? 0,
  };
}

export type AccountView = {
  address: string;
  microAlgos: number;
  minBalance: number;
  assets: { assetId: number; amount: number }[];
};

export async function accountInfo(address: string): Promise<AccountView> {
  const info = await algod().accountInformation(address).do();
  return {
    address,
    microAlgos: Number(info.amount),
    minBalance: Number(info.minBalance),
    assets: (info.assets ?? []).map(a => ({
      assetId: Number(a.assetId),
      amount: Number(a.amount),
    })),
  };
}

/** null means "not opted in", which is different from a zero balance. */
export async function assetBalance(address: string, assetId: number): Promise<number | null> {
  const info = await accountInfo(address);
  const holding = info.assets.find(a => a.assetId === assetId);
  return holding ? holding.amount : null;
}

export async function chainHealthy(): Promise<{ ok: boolean; round?: number; error?: string }> {
  try {
    const s = await algod().status().do();
    return { ok: true, round: Number(s.lastRound) };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}
