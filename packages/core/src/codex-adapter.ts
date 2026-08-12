import { Codex } from "@openai/codex-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Capability } from "./contracts.js";

export interface CodexAdapterOptions {
  /** Injected for tests; production uses the Codex SDK's local CLI bridge. */
  createClient?: () => Codex;
  /** Authentication probe is separate because constructing the SDK does not authenticate. */
  probeLogin?: () => Promise<boolean>;
}

/**
 * Reports the local Codex execution path explicitly. It never substitutes an
 * API-key provider: a caller must choose a separate BYOK capability instead.
 */
export async function getCodexCapability(options: CodexAdapterOptions = {}): Promise<Capability> {
  try {
    (options.createClient ?? (() => new Codex()))();
  } catch {
    return {
      id: "codex-session",
      state: "unavailable",
      executionModes: ["codex-session"],
      requiredAction: "Install the Codex CLI/SDK for this platform; no API key fallback will be used.",
    };
  }

  const probeLogin =
    options.probeLogin ??
    (async () => {
      const { stdout, stderr } = await promisify(execFile)("codex", ["login", "status"], {
        timeout: 5_000,
      });
      return `${stdout}${stderr}`.toLocaleLowerCase().includes("logged in");
    });

  try {
    if (await probeLogin()) {
      return {
        id: "codex-session",
        state: "available",
        executionModes: ["codex-session"],
      };
    }
  } catch {
    // The adapter exists, but a usable authenticated session was not confirmed.
  }

  return {
    id: "codex-session",
    state: "requires-login",
    executionModes: ["codex-session"],
    requiredAction: "Sign in to Codex locally; no API key fallback will be used.",
  };
}
