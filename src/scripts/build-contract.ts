/**
 * Compiles contracts/recourse/contract.py to TEAL + ARC-56.
 *
 * Requires the Algorand Python toolchain:
 *   pip install puyapy algorand-python
 *
 * The build output is committed, so this is only needed after editing the
 * contract. Deployment reads contracts/build/Recourse.arc56.json.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bar, bad, head, info, ok } from "./_envfile.ts";

const SOURCE = "contracts/recourse/contract.py";
const OUT = "../build";
const SPEC = resolve(process.cwd(), "contracts/build/Recourse.arc56.json");

function run(cmd: string, args: string[]) {
  return spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" });
}

console.log(bar());
console.log("  BUILD RECOURSE CONTRACT");
console.log(bar());

if (!existsSync(resolve(process.cwd(), SOURCE))) {
  bad(`missing ${SOURCE}`);
  process.exit(1);
}

head("compile");
const candidates = [
  ["python", ["-m", "puyapy", "--out-dir", OUT, "--output-arc56", "--output-teal", SOURCE]],
  ["python3", ["-m", "puyapy", "--out-dir", OUT, "--output-arc56", "--output-teal", SOURCE]],
  ["puyapy", ["--out-dir", OUT, "--output-arc56", "--output-teal", SOURCE]],
] as const;

let compiled = false;
for (const [cmd, args] of candidates) {
  const res = run(cmd, [...args]);
  if (res.status === 0) {
    ok(`compiled with ${cmd} -m puyapy`);
    compiled = true;
    break;
  }
  if (res.stderr && !/not recognized|No module named|ENOENT/i.test(res.stderr)) {
    console.error(res.stderr);
    bad("compilation failed");
    process.exit(1);
  }
}

if (!compiled) {
  bad("puyapy not found");
  info("install it", "pip install puyapy algorand-python");
  process.exit(1);
}

head("verify");
const spec = JSON.parse(readFileSync(SPEC, "utf8")) as {
  methods: { name: string; args: { type: string }[]; returns: { type: string } }[];
  state: { schema: { global: { ints: number; bytes: number } } };
  events?: { name: string }[];
};
for (const m of spec.methods) {
  info(m.name, `(${m.args.map(a => a.type).join(",")}) -> ${m.returns.type}`);
}
ok("global schema", `${spec.state.schema.global.ints} ints, ${spec.state.schema.global.bytes} bytes`);
ok("ARC-28 events", (spec.events ?? []).map(e => e.name).join(", ") || "none");

console.log(`\n${bar()}`);
console.log("  next: npm run contract:deploy");
console.log(bar());
