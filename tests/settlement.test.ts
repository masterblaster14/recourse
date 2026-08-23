/**
 * Settlement verification reads two different wire shapes.
 *
 * These fixtures are recorded from real TestNet responses for the same
 * transaction, and they exist because of a bug that produced no error at all:
 * the algod branch was reading the *indexer's* field names. `txType` and
 * `assetTransferTransaction` are simply absent from an algod response, so the
 * lookup returned `undefined` rather than throwing, and a perfectly good
 * payment was reported as "not an asset transfer (unknown)".
 *
 * That failure mode is the dangerous kind — the check appeared to run, appeared
 * to be strict, and quietly rejected every freshly settled payment, which is
 * the common case. Nothing in a happy-path test would have caught it, because
 * the happy path only worked when algod threw and the indexer fallback ran.
 *
 * Pinning both shapes offline keeps that honest without needing the network.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normaliseAlgodTxn, normaliseIndexerTxn } from "../src/lib/chain.ts";

const SENDER = "FBHEAA6NVCJTYH5J3JR2XM7XE6F6QEVD7TDD76HHV4EKJ7BNZINXA7X2PM";
const RECEIVER = "T7X54PQA7EXDPIRKNV3PHQFGXILNG7H7LWHFM4PNWDN2AJOFIHLOUX2Q74";

/** As algod returns it: a decoded algosdk Transaction, amounts as bigint. */
const ALGOD_RESPONSE = {
  confirmedRound: 66584323n,
  txn: {
    txn: {
      type: "axfer",
      sender: SENDER,
      assetTransfer: { assetIndex: 10458941n, amount: 1000n, receiver: RECEIVER },
    },
  },
};

/** As the indexer returns it: the REST shape, different names throughout. */
const INDEXER_RESPONSE = {
  transaction: {
    txType: "axfer",
    sender: SENDER,
    confirmedRound: 66584323,
    assetTransferTransaction: { assetId: 10458941, amount: 1000, receiver: RECEIVER },
  },
};

describe("normaliseAlgodTxn", () => {
  test("reads algod's field names, not the indexer's", () => {
    const t = normaliseAlgodTxn(ALGOD_RESPONSE);
    assert.ok(t);
    assert.equal(t.type, "axfer");
    assert.equal(t.sender, SENDER);
    assert.equal(t.receiver, RECEIVER);
    assert.equal(t.assetId, 10458941);
    assert.equal(t.amountMicro, 1000);
    assert.equal(t.confirmedRound, 66584323);
  });

  test("coerces bigint amounts, which algosdk returns for asset fields", () => {
    const t = normaliseAlgodTxn(ALGOD_RESPONSE)!;
    assert.equal(typeof t.amountMicro, "number");
    assert.equal(typeof t.assetId, "number");
  });

  test("returns null rather than a hollow object when there is no transaction", () => {
    assert.equal(normaliseAlgodTxn({}), null);
    assert.equal(normaliseAlgodTxn({ txn: {} }), null);
    assert.equal(normaliseAlgodTxn(undefined), null);
  });

  test("a non-transfer is reported as its real type, never as an asset transfer", () => {
    const t = normaliseAlgodTxn({ txn: { txn: { type: "pay", sender: SENDER } } })!;
    assert.equal(t.type, "pay");
    assert.equal(t.amountMicro, 0);
    assert.equal(t.receiver, "");
  });
});

describe("normaliseIndexerTxn", () => {
  test("reads the indexer's field names", () => {
    const t = normaliseIndexerTxn(INDEXER_RESPONSE);
    assert.ok(t);
    assert.equal(t.type, "axfer");
    assert.equal(t.sender, SENDER);
    assert.equal(t.receiver, RECEIVER);
    assert.equal(t.assetId, 10458941);
    assert.equal(t.amountMicro, 1000);
  });

  test("returns null when the transaction is absent", () => {
    assert.equal(normaliseIndexerTxn({}), null);
    assert.equal(normaliseIndexerTxn(undefined), null);
  });
});

describe("the two sources agree", () => {
  test("the same transaction normalises identically from either source", () => {
    const a = normaliseAlgodTxn(ALGOD_RESPONSE)!;
    const i = normaliseIndexerTxn(INDEXER_RESPONSE)!;
    assert.deepEqual(a, i, "algod and indexer must produce the same verdict input");
  });

  test("neither source reads the other's names", () => {
    // The exact confusion that caused the bug: cross the shapes over and both
    // must fail to find a transfer rather than silently inventing one.
    const crossed = normaliseAlgodTxn({ txn: { txn: INDEXER_RESPONSE.transaction } })!;
    assert.notEqual(crossed.type, "axfer", "algod reader must not accept indexer field names");
    assert.equal(crossed.amountMicro, 0);
  });
});
