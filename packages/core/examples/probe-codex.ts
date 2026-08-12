import { Codex } from "@openai/codex-sdk";

import { getCodexCapability, smokeTestCodexExecution } from "../src/codex-adapter.ts";

const capability = await getCodexCapability({
  smokeTest: smokeTestCodexExecution,
  createClient: () => new Codex(),
});

process.stdout.write(`${JSON.stringify(capability, null, 2)}\n`);
if (capability.state !== "available") process.exitCode = 1;
