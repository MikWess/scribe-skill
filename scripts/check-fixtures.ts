import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const fixtureFiles = tracked.filter((path) => /(^|\/)(?:test-)?fixtures?\//i.test(path));
const invalidPaths = fixtureFiles.filter(
  (path) => !path.startsWith("test-fixtures/") && !/^packages\/[^/]+\/fixtures\//.test(path),
);

const sensitivePatterns: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["OpenAI-style secret", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["AWS access key", /\bAKIA[A-Z0-9]{16}\b/],
  ["US social security number", /\b\d{3}-\d{2}-\d{4}\b/],
  ["non-example email", /\b[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
];
const violations: string[] = invalidPaths.map((path) => `${path}: fixture is outside an approved path`);

for (const path of fixtureFiles) {
  if (/\.(?:png|jpe?g|pdf|mp3|mp4|wav)$/i.test(path)) continue;
  const contents = readFileSync(path, "utf8");
  for (const [label, pattern] of sensitivePatterns) {
    if (pattern.test(contents)) violations.push(`${path}: possible ${label}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${fixtureFiles.length} fixture files; no obvious secrets or PII found.\n`);
}
