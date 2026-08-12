import { Codex } from "@openai/codex-sdk";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Capability } from "./contracts.js";

export interface CodexAdapterOptions {
  /** Injected for tests; production uses the Codex SDK's local CLI bridge. */
  createClient?: () => Codex;
  /** Authentication probe is separate because constructing the SDK does not authenticate. */
  probeLogin?: () => Promise<boolean>;
  /** Optional bounded functional probe. Without it the authenticated capability stays unverified. */
  smokeTest?: (client: Codex) => Promise<boolean>;
}

export async function smokeTestCodexExecution(client: Codex): Promise<boolean> {
  const workspace = await mkdtemp(join(tmpdir(), "scribe-skill-codex-probe-"));
  try {
    const thread = client.startThread({
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    });
    const result = await thread.run(
      "This is a capability probe. Do not use tools. Reply with exactly SCRIBE_SKILL_CODEX_OK.",
    );
    return result.finalResponse.trim() === "SCRIBE_SKILL_CODEX_OK";
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/**
 * Reports the local Codex execution path explicitly. It never substitutes an
 * API-key provider: a caller must choose a separate BYOK capability instead.
 */
export async function getCodexCapability(options: CodexAdapterOptions = {}): Promise<Capability> {
  let client: Codex;
  try {
    client = (options.createClient ?? (() => new Codex()))();
  } catch {
    return {
      id: "codex-session",
      state: "unavailable",
      executionModes: ["codex-session"],
      requiredAction: "Install the Codex CLI/SDK for this platform; no API key fallback will be used.",
      checks: {
        sdkInstalled: false,
        authenticated: false,
        smokeTested: false,
        workspaceAccess: false,
        networkDisabled: true,
      },
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
      if (!options.smokeTest) {
        return {
          id: "codex-session",
          state: "unverified",
          executionModes: ["codex-session"],
          requiredAction: "Run the bounded Codex SDK smoke test before autonomous execution.",
          checks: {
            sdkInstalled: true,
            authenticated: true,
            smokeTested: false,
            workspaceAccess: false,
            networkDisabled: true,
          },
        };
      }
      const operational = await options.smokeTest(client);
      return {
        id: "codex-session",
        state: operational ? "available" : "unavailable",
        executionModes: ["codex-session"],
        requiredAction: operational ? undefined : "Codex authenticated but failed the bounded SDK smoke test.",
        checks: {
          sdkInstalled: true,
          authenticated: true,
          smokeTested: true,
          workspaceAccess: operational,
          networkDisabled: true,
        },
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
    checks: {
      sdkInstalled: true,
      authenticated: false,
      smokeTested: false,
      workspaceAccess: false,
      networkDisabled: true,
    },
  };
}
