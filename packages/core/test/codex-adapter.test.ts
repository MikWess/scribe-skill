import assert from "node:assert/strict";
import test from "node:test";

import { getCodexCapability } from "../src/codex-adapter.ts";

test("reports a usable Codex session without an API-key fallback", () => {
  const result = getCodexCapability({ createClient: () => ({}) as never });

  assert.deepEqual(result, {
    id: "codex-session",
    state: "available",
    executionModes: ["codex-session"],
  });
});

test("asks for local login when Codex cannot be created", () => {
  const result = getCodexCapability({
    createClient: () => {
      throw new Error("not signed in");
    },
  });

  assert.equal(result.state, "requires-login");
  assert.match(result.requiredAction ?? "", /no API key fallback/);
});
