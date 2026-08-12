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

export type ContextSourceKind =
  | "chapter"
  | "passage-search"
  | "graph-neighborhood"
  | "figure"
  | "table";

/**
 * A navigation guide is the operational part of an exported skill. It tells
 * an agent which book context to load for a task and how to verify its use.
 */
export interface SkillNavigationGuide {
  schemaVersion: "1.0";
  skillId: string;
  documentHash: string;
  purpose: string;
  routes: ContextRoute[];
  answerPolicy: {
    requireEvidenceAnchors: boolean;
    distinguishInference: boolean;
    refuseWhenUnsupported: boolean;
  };
}

export interface ContextRoute {
  id: string;
  description: string;
  triggers: string[];
  tasks: string[];
  context: ContextRequest[];
  usageInstructions: string[];
}

export interface ContextRequest {
  source: ContextSourceKind;
  selector: string;
  reason: string;
  maxTokens: number;
  required: boolean;
}

export interface NavigationDecision {
  routeIds: string[];
  context: ContextRequest[];
  usageInstructions: string[];
  unmatched: boolean;
}
