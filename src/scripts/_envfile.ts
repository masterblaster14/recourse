import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_PATH = resolve(process.cwd(), ".env");

/** Rewrites a single key in .env in place, preserving comments and order. */
export function setEnvValue(key: string, value: string): void {
  const raw = readFileSync(ENV_PATH, "utf8");
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  const next = re.test(raw) ? raw.replace(re, line) : `${raw.trimEnd()}\n${line}\n`;
  writeFileSync(ENV_PATH, next, "utf8");
  process.env[key] = value;
}

export const bar = (n = 74) => "─".repeat(n);

export function ok(label: string, detail = ""): void {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  ${detail}` : ""}`);
}
export function bad(label: string, detail = ""): void {
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  ${detail}` : ""}`);
}
export function warn(label: string, detail = ""): void {
  console.log(`  \x1b[33m!\x1b[0m ${label}${detail ? `  ${detail}` : ""}`);
}
export function info(label: string, detail = ""): void {
  console.log(`  \x1b[36m·\x1b[0m ${label}${detail ? `  ${detail}` : ""}`);
}
export function head(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}
