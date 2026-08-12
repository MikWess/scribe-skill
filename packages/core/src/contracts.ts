/** A source location that remains inspectable through every derivative. */
export interface EvidenceAnchor {
  documentHash: string;
  page: number;
  blockId: string;
  characterRange: { start: number; end: number };
  extractionRevision: number;
  boundingBox?: { x: number; y: number; width: number; height: number };
  region?: { kind: "figure" | "table" | "caption"; id: string };
}

export type ExecutionMode = "offline" | "byok" | "codex-session";
export type CapabilityState = "available" | "requires-login" | "unavailable";

export interface Capability {
  id: string;
  state: CapabilityState;
  executionModes: ExecutionMode[];
  requiredAction?: string;
}

export interface RunRequest {
  idempotencyKey: string;
  scope: "extract" | "retrieve" | "graph" | "skill" | "audio" | "video";
  executionMode: ExecutionMode;
  budget: { maxCostUsd?: number; maxDurationMs?: number; maxTurns?: number };
}
