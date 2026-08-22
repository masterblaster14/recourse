/**
 * Generates the four TestNet accounts Recourse needs and writes a ready-to-fund
 * .env. Run once. If .env already exists it is left alone unless --force.
 */
import algosdk from "algosdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_PATH = resolve(process.cwd(), ".env");
const force = process.argv.includes("--force");

if (existsSync(ENV_PATH) && !force) {
  console.error(`.env already exists at ${ENV_PATH}`);
  console.error("Refusing to overwrite live keys. Re-run with --force if you really mean it.");
  process.exit(1);
}

type Acct = { addr: string; mnemonic: string };

function newAccount(): Acct {
  const a = algosdk.generateAccount();
  return { addr: a.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(a.sk) };
}

/** A separate ed25519 keypair a provider uses to sign responses. Deliberately
 *  NOT the same key that holds its bond — signing keys are hot, bonds are not. */
function newSigningKey(): { sk_b64: string; pk_b64: string } {
  const a = algosdk.generateAccount();
  return {
    sk_b64: Buffer.from(a.sk).toString("base64"),
    pk_b64: Buffer.from(a.addr.publicKey).toString("base64"),
  };
}

const deployer = newAccount();
const providerA = newAccount();
const providerB = newAccount();
const agent = newAccount();
const signA = newSigningKey();
const signB = newSigningKey();

const adminKey = Buffer.from(algosdk.generateAccount().sk.slice(0, 24)).toString("base64url");

const env = `# ---------------------------------------------------------------- network
ALGOD_URL=https://testnet-api.algonode.cloud
ALGOD_TOKEN=
INDEXER_URL=https://testnet-idx.algonode.cloud
NETWORK=testnet
NETWORK_CAIP2=algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=
EXPLORER_BASE=https://lora.algokit.io/testnet

# ------------------------------------------------------------------- x402
FACILITATOR_URL=https://facilitator.goplausible.xyz
# Verified live from the chain, not copied from a blog post:
#   testnet asset 10458941 = USDC, 6 decimals, creator VETIGP3I...
# The GoPlausible AVM "exact" scheme requires an ASA transfer; native ALGO is
# rejected with ErrNotAssetTransfer. Any ASA id works here.
PAYMENT_ASSET_ID=10458941
PAYMENT_ASSET_DECIMALS=6
PAYMENT_ASSET_SYMBOL=USDC

# -------------------------------------------------------------- economics
# All values in micro units of PAYMENT_ASSET (6 dp).
# price 1000 = 0.001   refund 1000 + slash 9000 = 10000 per upheld claim
# bond 200000 = 0.2 covers exactly 20 upheld claims, so a 50-call demo drains
# the violating provider to zero on stage.
PRICE_MICRO=1000
SCORE_PRICE_MICRO=1000
BOND_MICRO=200000
SLA_MAX_STALENESS_S=60
SLA_MAX_LATENCY_MS=800
STALE_OFFSET_S=2700

# --------------------------------------------------------------- contract
RECOURSE_APP_ID=

# --------------------------------------------------------------- accounts
DEPLOYER_ADDRESS=${deployer.addr}
DEPLOYER_MNEMONIC=${deployer.mnemonic}
TREASURY_ADDRESS=${deployer.addr}

PROVIDER_A_ADDRESS=${providerA.addr}
PROVIDER_A_MNEMONIC=${providerA.mnemonic}
PROVIDER_A_SIGNING_SK=${signA.sk_b64}
PROVIDER_A_SIGNING_PK=${signA.pk_b64}

PROVIDER_B_ADDRESS=${providerB.addr}
PROVIDER_B_MNEMONIC=${providerB.mnemonic}
PROVIDER_B_SIGNING_SK=${signB.sk_b64}
PROVIDER_B_SIGNING_PK=${signB.pk_b64}

AGENT_ADDRESS=${agent.addr}
AGENT_MNEMONIC=${agent.mnemonic}

# -------------------------------------------------------------------- app
PORT=3000
PUBLIC_URL=http://localhost:3000
ADMIN_KEY=${adminKey}
DATABASE_URL=
`;

writeFileSync(ENV_PATH, env, "utf8");

const line = "─".repeat(74);
console.log(line);
console.log("  Recourse TestNet accounts generated → .env");
console.log(line);
console.log("");
console.log("  FUND THESE (TestNet ALGO):");
console.log(`    Deployer / treasury   ${deployer.addr}    ~5 ALGO`);
console.log(`    Provider A            ${providerA.addr}    ~1 ALGO`);
console.log(`    Provider B            ${providerB.addr}    ~1 ALGO`);
console.log(`    Agent (buyer)         ${agent.addr}    ~2 ALGO`);
console.log("");
console.log("  FUND THIS ONE ONLY (TestNet USDC, asset 10458941):");
console.log(`    Deployer              ${deployer.addr}    >= 1 USDC`);
console.log("    (setup.ts opts in the others and distributes from here)");
console.log("");
console.log(line);
