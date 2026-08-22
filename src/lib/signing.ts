/**
 * Response signing and verification.
 *
 * This is the mechanism that removes the game theory from the whole system.
 * A provider signs (request_id || sha256(canonical(data)) || be64(data_timestamp)).
 * That signature is a self-incriminating admission: if data_timestamp is older
 * than the staleness bound the provider itself published on chain, the contract
 * can prove the violation from the signature alone. Nobody adjudicates.
 *
 * The exact same bytes must be produced on both sides, so canonicalisation
 * lives here and only here.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

/** DER wrappers so node:crypto will accept raw 32-byte ed25519 keys. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Deterministic JSON: object keys sorted at every level, no whitespace.
 * Both the provider and the agent must produce byte-identical output or the
 * hash check fails, so neither side is allowed its own stringifier.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(input: Buffer | string): Buffer {
  return createHash("sha256").update(input).digest();
}

/** sha256 over the canonical JSON of the payload. */
export function responseHash(data: unknown): Buffer {
  return sha256(Buffer.from(canonicalJson(data), "utf8"));
}

export function uint64BE(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(value));
  return buf;
}

/**
 * The exact bytes the provider signs and the contract verifies.
 * Mirrors `msg = request_id + response_hash + op.itob(data_timestamp)`.
 */
export function claimMessage(
  requestId: Buffer,
  respHash: Buffer,
  dataTimestamp: number | bigint,
): Buffer {
  if (requestId.length !== 32) throw new Error("request_id must be 32 bytes");
  if (respHash.length !== 32) throw new Error("response_hash must be 32 bytes");
  return Buffer.concat([requestId, respHash, uint64BE(dataTimestamp)]);
}

/** `secretKeyB64` is the 64-byte algosdk sk (seed || pubkey); we use the seed. */
export function ed25519Sign(message: Buffer, secretKeyB64: string): Buffer {
  const sk = Buffer.from(secretKeyB64, "base64");
  const seed = sk.subarray(0, 32);
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, message, key);
}

export function ed25519Verify(
  message: Buffer,
  signature: Buffer,
  publicKey: Buffer,
): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]),
      format: "der",
      type: "spki",
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** The 32-byte public key that pairs with a 64-byte algosdk-style secret key. */
export function publicKeyFromSecret(secretKeyB64: string): Buffer {
  return Buffer.from(secretKeyB64, "base64").subarray(32, 64);
}

/** sha256 of the canonical SLA document. Committed on chain at register time. */
export function slaHash(sla: unknown): Buffer {
  return responseHash(sla);
}
