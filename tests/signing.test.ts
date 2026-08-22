/**
 * The signing layer is the load-bearing part of the whole system: if the bytes
 * the provider signs and the bytes the contract verifies ever diverge, every
 * claim silently stops working. These tests pin that byte layout down.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import algosdk from "algosdk";
import {
  canonicalJson,
  claimMessage,
  ed25519Sign,
  ed25519Verify,
  publicKeyFromSecret,
  responseHash,
  sha256,
  slaHash,
  uint64BE,
} from "../src/lib/signing.ts";

const account = algosdk.generateAccount();
const SK = Buffer.from(account.sk).toString("base64");
const PK = publicKeyFromSecret(SK);

const DATA = { symbol: "ALGO/USD", price: 0.1842, data_timestamp: 1755880000 };

describe("canonicalJson", () => {
  test("sorts keys at every level", () => {
    assert.equal(canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } }), '{"a":2,"b":1,"c":{"y":2,"z":1}}');
  });

  test("is insensitive to insertion order", () => {
    const a = canonicalJson({ symbol: "X", price: 1, data_timestamp: 2 });
    const b = canonicalJson({ data_timestamp: 2, price: 1, symbol: "X" });
    assert.equal(a, b);
  });

  test("emits no whitespace", () => {
    assert.ok(!/\s/.test(canonicalJson({ a: 1, b: { c: 2 } })));
  });

  test("preserves array order", () => {
    assert.equal(canonicalJson({ xs: [3, 1, 2] }), '{"xs":[3,1,2]}');
  });

  test("sorts keys inside arrays of objects", () => {
    assert.equal(canonicalJson([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
  });
});

describe("hashing", () => {
  test("responseHash is 32 bytes and deterministic", () => {
    const h1 = responseHash(DATA);
    const h2 = responseHash({ data_timestamp: DATA.data_timestamp, price: DATA.price, symbol: DATA.symbol });
    assert.equal(h1.length, 32);
    assert.deepEqual(h1, h2);
  });

  test("responseHash changes when any field changes", () => {
    const base = responseHash(DATA);
    assert.notDeepEqual(base, responseHash({ ...DATA, price: 0.1843 }));
    assert.notDeepEqual(base, responseHash({ ...DATA, data_timestamp: DATA.data_timestamp + 1 }));
    assert.notDeepEqual(base, responseHash({ ...DATA, symbol: "ALGO/EUR" }));
  });

  test("sha256 matches a known vector", () => {
    assert.equal(
      sha256("abc").toString("hex"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("slaHash is stable across key ordering", () => {
    const a = slaHash({ version: 1, price_micro: 1000, max_staleness_s: 60 });
    const b = slaHash({ max_staleness_s: 60, price_micro: 1000, version: 1 });
    assert.deepEqual(a, b);
  });
});

describe("uint64BE", () => {
  test("encodes big-endian in 8 bytes, matching the AVM itob", () => {
    assert.equal(uint64BE(0).toString("hex"), "0000000000000000");
    assert.equal(uint64BE(1).toString("hex"), "0000000000000001");
    assert.equal(uint64BE(1755880000).toString("hex"), "0000000068a89a40");
    assert.equal(Number(BigInt("0x68a89a40")), 1755880000);
  });
});

describe("claimMessage", () => {
  const rid = randomBytes(32);
  const rh = responseHash(DATA);

  test("is exactly request_id || response_hash || uint64_be(ts)", () => {
    const msg = claimMessage(rid, rh, DATA.data_timestamp);
    assert.equal(msg.length, 72);
    assert.deepEqual(msg.subarray(0, 32), rid);
    assert.deepEqual(msg.subarray(32, 64), rh);
    assert.deepEqual(msg.subarray(64, 72), uint64BE(DATA.data_timestamp));
  });

  test("rejects wrongly sized inputs rather than producing a bad message", () => {
    assert.throws(() => claimMessage(randomBytes(31), rh, 1), /request_id must be 32 bytes/);
    assert.throws(() => claimMessage(rid, randomBytes(33), 1), /response_hash must be 32 bytes/);
  });
});

describe("ed25519", () => {
  const rid = randomBytes(32);
  const rh = responseHash(DATA);
  const msg = claimMessage(rid, rh, DATA.data_timestamp);
  const sig = ed25519Sign(msg, SK);

  test("public key derived from the secret matches the Algorand address", () => {
    assert.deepEqual(PK, Buffer.from(account.addr.publicKey));
  });

  test("signature is 64 bytes and verifies", () => {
    assert.equal(sig.length, 64);
    assert.equal(ed25519Verify(msg, sig, PK), true);
  });

  test("rejects a tampered timestamp", () => {
    assert.equal(ed25519Verify(claimMessage(rid, rh, DATA.data_timestamp + 1), sig, PK), false);
  });

  test("rejects a tampered payload hash", () => {
    assert.equal(ed25519Verify(claimMessage(rid, responseHash({ ...DATA, price: 9 }), DATA.data_timestamp), sig, PK), false);
  });

  test("rejects a flipped signature byte", () => {
    const bad = Buffer.from(sig);
    bad[10] ^= 0xff;
    assert.equal(ed25519Verify(msg, bad, PK), false);
  });

  test("rejects a different signer's key", () => {
    const other = publicKeyFromSecret(Buffer.from(algosdk.generateAccount().sk).toString("base64"));
    assert.equal(ed25519Verify(msg, sig, other), false);
  });

  test("rejects malformed key or signature lengths without throwing", () => {
    assert.equal(ed25519Verify(msg, sig.subarray(0, 63), PK), false);
    assert.equal(ed25519Verify(msg, sig, PK.subarray(0, 31)), false);
  });

  test("signing is deterministic, as ed25519 requires", () => {
    assert.deepEqual(ed25519Sign(msg, SK), ed25519Sign(msg, SK));
  });
});
