# Security policy

Please report vulnerabilities privately through GitHub's security-advisory flow. Do not open a public issue containing a secret, private document, or exploitable detail.

## Initial threat model

ScribeSkill treats imported documents, extracted text, metadata, annotations, generated prompts, and provider responses as untrusted/private data. Important boundaries are the local desktop process, loopback API/MCP authentication, OS keychain, provider egress, exported artifacts, and generated skill instructions.

Foundation requirements:

- default to loopback and no provider egress;
- never store provider credentials in SQLite, logs, skill exports, or job manifests;
- record and approve the exact source spans sent in BYOK mode;
- treat PDF content and generated skill text as data, never privileged instructions;
- constrain file access to an explicit workspace and make runs cancellable/auditable;
- preserve source provenance and label inferred or unsupported content.

The threat model will evolve with each PR that adds an executable boundary.
