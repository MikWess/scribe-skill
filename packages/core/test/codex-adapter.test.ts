import assert from "node:assert/strict";
import test from "node:test";

import { getCodexCapability } from "../src/codex-adapter.ts";

test("reports a usable Codex session without an API-key fallback", async () => {
  const result = await getCodexCapability({
    createClient: () => ({}) as never,
    probeLogin: async () => true,
    smokeTest: async () => true,
  });

  assert.deepEqual(result, {
    id: "codex-session",
    state: "available",
    executionModes: ["codex-session"],
    requiredAction: undefined,
    checks: {
      sdkInstalled: true,
      authenticated: true,
      smokeTested: true,
      workspaceAccess: true,
      networkDisabled: true,
    },
  });
});

test("asks for local login when authentication is not confirmed", async () => {
  const result = await getCodexCapability({
    createClient: () => ({}) as never,
    probeLogin: async () => false,
  });

  assert.equal(result.state, "requires-login");
  assert.match(result.requiredAction ?? "", /no API key fallback/);
});

test("reports unavailable when the Codex SDK cannot resolve its runtime", async () => {
  const result = await getCodexCapability({
    createClient: () => {
      throw new Error("unsupported platform");
    },
  });

  assert.equal(result.state, "unavailable");
  assert.match(result.requiredAction ?? "", /Install/);
});

test("keeps an authenticated adapter unverified until its bounded smoke test runs", async () => {
  const result = await getCodexCapability({
    createClient: () => ({}) as never,
    probeLogin: async () => true,
  });

  assert.equal(result.state, "unverified");
  assert.equal(result.checks?.smokeTested, false);
});
