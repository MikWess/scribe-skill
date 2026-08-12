import { Codex } from "@openai/codex-sdk";

import type { Capability } from "./contracts.js";

export interface CodexAdapterOptions {
  /** Injected for tests; production uses the Codex SDK's local CLI bridge. */
  createClient?: () => Codex;
}

/**
 * Reports the local Codex execution path explicitly. It never substitutes an
 * API-key provider: a caller must choose a separate BYOK capability instead.
 */
export function getCodexCapability(options: CodexAdapterOptions = {}): Capability {
  try {
    options.createClient?.();
    return {
      id: "codex-session",
      state: "available",
      executionModes: ["codex-session"],
    };
  } catch {
    return {
      id: "codex-session",
      state: "requires-login",
      executionModes: ["codex-session"],
      requiredAction: "Sign in to Codex locally; no API key fallback will be used.",
    };
  }
}
