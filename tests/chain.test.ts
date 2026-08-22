/**
 * The Provider struct is decoded from raw box bytes rather than through a
 * simulate call, which is fast and free but means the layout is hand-written on
 * this side. If the contract's struct ever changes, these fail first.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import algosdk from "algosdk";
import { claimBoxName, decodeProvider, providerBoxName, spec } from "../src/lib/chain.ts";

const ADDR = algosdk.generateAccount().addr.toString();

/** Build a 121-byte ARC-4 Provider struct by hand. */
function encodeProvider(v: {
  pubkey?: Buffer; slaHash?: Buffer; price?: number; staleness?: number; latency?: number;
  bond?: number; success?: number; claims?: number; slashed?: number; active?: boolean;
}): Uint8Array {
  const b = Buffer.alloc(121);
  (v.pubkey ?? Buffer.alloc(32, 0xaa)).copy(b, 0);
  (v.slaHash ?? Buffer.alloc(32, 0xbb)).copy(b, 32);
  b.writeBigUInt64BE(BigInt(v.price ?? 1000), 64);
  b.writeBigUInt64BE(BigInt(v.staleness ?? 60), 72);
  b.writeBigUInt64BE(BigInt(v.latency ?? 8000), 80);
  b.writeBigUInt64BE(BigInt(v.bond ?? 100_000), 88);
  b.writeBigUInt64BE(BigInt(v.success ?? 7), 96);
  b.writeBigUInt64BE(BigInt(v.claims ?? 3), 104);
  b.writeBigUInt64BE(BigInt(v.slashed ?? 30_000), 112);
  // ARC-4 packs a trailing bool into one byte, value in the high bit.
  b[120] = (v.active ?? true) ? 0x80 : 0x00;
  return new Uint8Array(b);
}

describe("decodeProvider", () => {
  test("reads every field back out of the packed struct", () => {
    const p = decodeProvider(ADDR, encodeProvider({}));
    assert.equal(p.address, ADDR);
    assert.equal(p.pubkey.length, 32);
    assert.equal(p.slaHash.length, 32);
    assert.equal(p.priceMicro, 1000);
    assert.equal(p.maxStaleness, 60);
    assert.equal(p.maxLatencyMs, 8000);
    assert.equal(p.bondMicro, 100_000);
    assert.equal(p.successCount, 7);
    assert.equal(p.claimCount, 3);
    assert.equal(p.slashedMicro, 30_000);
    assert.equal(p.active, true);
  });

  test("decodes the ARC-4 bool from the high bit, not from truthiness", () => {
    assert.equal(decodeProvider(ADDR, encodeProvider({ active: false })).active, false);
    assert.equal(decodeProvider(ADDR, encodeProvider({ active: true })).active, true);
  });

  test("survives an exhausted provider", () => {
    const p = decodeProvider(ADDR, encodeProvider({ bond: 0, active: false, claims: 10 }));
    assert.equal(p.bondMicro, 0);
    assert.equal(p.active, false);
    assert.equal(p.claimCount, 10);
  });

  test("refuses a short box rather than returning silent nonsense", () => {
    assert.throws(() => decodeProvider(ADDR, new Uint8Array(120)), /too short/);
  });
});

describe("box names", () => {
  test("provider box is the p_ prefix plus the 32-byte public key", () => {
    const name = providerBoxName(ADDR);
    assert.equal(name.length, 34);
    assert.equal(Buffer.from(name.subarray(0, 2)).toString("utf8"), "p_");
    assert.deepEqual(
      Buffer.from(name.subarray(2)),
      Buffer.from(algosdk.decodeAddress(ADDR).publicKey),
    );
  });

  test("claim box is the c_ prefix plus the 32-byte request id", () => {
    const rid = Buffer.alloc(32, 0x11);
    const name = claimBoxName(rid);
    assert.equal(name.length, 34);
    assert.equal(Buffer.from(name.subarray(0, 2)).toString("utf8"), "c_");
    assert.deepEqual(Buffer.from(name.subarray(2)), rid);
  });

  test("different providers never collide", () => {
    const a = providerBoxName(algosdk.generateAccount().addr.toString());
    const b = providerBoxName(algosdk.generateAccount().addr.toString());
    assert.notDeepEqual(a, b);
  });
});

describe("compiled app spec", () => {
  const s = spec();

  test("exposes every method the client calls", () => {
    const names = s.methods.map(m => m.name);
    for (const m of [
      "create", "opt_in_asset", "register", "deposit_bond", "withdraw_bond",
      "submit_claim", "record_success", "read_provider", "is_claimed", "noop",
    ]) {
      assert.ok(names.includes(m), `missing ABI method: ${m}`);
    }
  });

  test("submit_claim takes the proof the contract needs to verify alone", () => {
    const m = s.methods.find(x => x.name === "submit_claim")!;
    assert.deepEqual(m.args.map(a => a.type), ["address", "byte[]", "byte[]", "uint64", "byte[]"]);
    assert.equal(m.returns.type, "uint64");
  });

  test("Provider decodes to the 121-byte layout this module assumes", () => {
    const m = s.methods.find(x => x.name === "read_provider")!;
    assert.equal(m.returns.type, "(byte[32],byte[32],uint64,uint64,uint64,uint64,uint64,uint64,uint64,bool)");
  });

  test("carries embedded TEAL so deployment needs no local compiler", () => {
    assert.ok(s.source?.approval && s.source.approval.length > 0);
    assert.ok(s.source?.clear && s.source.clear.length > 0);
  });
});
