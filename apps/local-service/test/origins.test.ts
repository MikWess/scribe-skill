import test from "node:test";
import assert from "node:assert/strict";
import { readerOrigins } from "../src/origins.ts";
import { startLocalService } from "../src/server.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("custom reader ports work while other origins remain blocked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-origins-"));
  const service = await startLocalService({token: "test", workspacePath: root,
    allowedOrigins: readerOrigins({SCRIBE_SKILL_UI_PORT: "5188"})});
  t.after(async () => { await service.close(); await rm(root, {recursive: true, force: true}); });
  const allowed = await fetch(`${service.url}/api/health`, {headers: {origin: "http://127.0.0.1:5188", "x-scribe-token": "test"}});
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://127.0.0.1:5188");
  const blocked = await fetch(`${service.url}/api/health`, {headers: {origin: "http://127.0.0.1:5173", "x-scribe-token": "test"}});
  assert.equal(blocked.status, 403);
});

test("explicit origin allowlists override defaults, including an empty list", () => {
  assert.deepEqual(readerOrigins({SCRIBE_SKILL_ALLOWED_ORIGINS: " http://localhost:6000, "}), ["http://localhost:6000"]);
  assert.deepEqual(readerOrigins({SCRIBE_SKILL_ALLOWED_ORIGINS: ""}), []);
  assert.throws(() => readerOrigins({SCRIBE_SKILL_UI_PORT: "invalid"}), /valid port/);
});
