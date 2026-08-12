import type { SkillManifest } from "./contracts.js";
import { sha256 } from "./evidence.ts";

export function createSkillManifest(input: {
  documentHash: string;
  extractionRevision: number;
  parser: SkillManifest["parser"];
  artifacts: Record<string, string | Uint8Array>;
  createdAt?: string;
}): SkillManifest {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    schemaVersion: "1.0",
    documentHash: input.documentHash,
    extractionRevision: input.extractionRevision,
    parser: input.parser,
    artifactHashes: Object.fromEntries(
      Object.entries(input.artifacts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, contents]) => [path, sha256(contents)]),
    ),
    createdAt,
    validation: { status: "ready", validatedAt: createdAt },
  };
}

export function validateSkillIntegrity(
  manifest: SkillManifest,
  artifacts: Record<string, string | Uint8Array>,
): string[] {
  const errors: string[] = [];
  for (const [path, expected] of Object.entries(manifest.artifactHashes)) {
    const contents = artifacts[path];
    if (contents === undefined) errors.push(`Missing artifact: ${path}`);
    else if (sha256(contents) !== expected) errors.push(`Artifact integrity failure: ${path}`);
  }
  for (const path of Object.keys(artifacts)) {
    if (!manifest.artifactHashes[path]) errors.push(`Untracked artifact: ${path}`);
  }
  return errors;
}
