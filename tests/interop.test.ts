/**
 * Canonicalisation interop.
 *
 * Our canonical JSON is the basis of every hash in this system — the response
 * digest a provider signs and the SLA hash it commits on chain. "It is correct
 * because we wrote it" is not evidence, so it is checked against a third
 * party's published vectors instead.
 *
 * Vectors: payment-requirements-hash.v1 from t54-labs/x402-secure (Apache-2.0),
 * covering the cases where independent implementations usually diverge —
 * unicode, nested key ordering, booleans, nulls and nested arrays.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, sha256 } from "../src/lib/signing.ts";

type Vector = {
  name: string;
  paymentRequirements: unknown;
  expectedCanonicalJson: string;
  expectedHash: string;
};

const file = JSON.parse(
  readFileSync(resolve(process.cwd(), "test-vectors/payment_requirements_hash.json"), "utf8"),
) as { version: string; vectors: Vector[] };

describe(`canonical JSON interop (${file.version})`, () => {
  test("the vector file is the one we think it is", () => {
    assert.equal(file.version, "payment-requirements-hash.v1");
    assert.ok(file.vectors.length >= 6, "expected at least 6 vectors");
  });

  for (const v of file.vectors) {
    test(`${v.name}: byte-identical canonical form`, () => {
      assert.equal(canonicalJson(v.paymentRequirements), v.expectedCanonicalJson);
    });

    test(`${v.name}: identical sha256`, () => {
      const hash = `sha256:${sha256(Buffer.from(canonicalJson(v.paymentRequirements), "utf8")).toString("hex")}`;
      assert.equal(hash, v.expectedHash);
    });
  }
});
