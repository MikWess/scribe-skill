import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isTrustedRendererUrl, ProviderSecretStore, parseProviderName } from "../electron/secret-store.ts";

test("provider IPC names reject arbitrary values", () => {
  assert.equal(parseProviderName("openai"), "openai");
  assert.throws(() => parseProviderName("https://attacker.example"), /Unknown voice provider/);
});

test("provider IPC accepts only the private app origin", () => {
  assert.equal(isTrustedRendererUrl("scribe-skill://app/index.html"), true);
  assert.equal(isTrustedRendererUrl("scribe-skill://app.evil/index.html"), false);
  assert.equal(isTrustedRendererUrl("https://attacker.example/"), false);
});

test("provider secrets are encrypted at rest, replaceable, readable, and removable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-secrets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "providers.json");
  const prefix = "cipher:";
  const store = new ProviderSecretStore(filePath, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`${prefix}${[...value].reverse().join("")}`),
    decryptString: (value) => [...value.toString("utf8").slice(prefix.length)].reverse().join(""),
  });

  await store.set("openai", "first-secret");
  assert.equal(await store.get("openai"), "first-secret");
  assert.equal((await readFile(filePath, "utf8")).includes("first-secret"), false);
  await store.set("openai", "replacement-secret");
  assert.equal(await store.get("openai"), "replacement-secret");
  await store.delete("openai");
  assert.equal(await store.has("openai"), false);
  assert.equal(await store.get("openai"), undefined);
});

test("concurrent provider-key updates preserve both providers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-secrets-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProviderSecretStore(join(root, "providers.json"), {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString("utf8"),
  });
  await Promise.all([
    store.set("openai", "openai-secret"),
    store.set("elevenlabs", "elevenlabs-secret"),
  ]);
  assert.equal(await store.get("openai"), "openai-secret");
  assert.equal(await store.get("elevenlabs"), "elevenlabs-secret");
});

test("provider secrets fail closed when secure storage is unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-secrets-unavailable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProviderSecretStore(join(root, "providers.json"), {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  await assert.rejects(() => store.set("elevenlabs", "secret"), /secure storage is unavailable/);
});
