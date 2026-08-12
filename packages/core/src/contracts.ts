/** A source location that remains inspectable through every derivative. */
export interface EvidenceAnchor {
  id: string;
  documentHash: string;
  page: number;
  blockId: string;
  characterRange: { start: number; end: number };
  extractionRevision: number;
  /** Hash of the exact source text covered by this anchor. */
  contentHash: string;
  /** Hash of the rendered page used to detect silent re-OCR/reflow changes. */
  pageImageHash?: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
  region?: { kind: "figure" | "table" | "caption"; id: string };
}

export type ExecutionMode = "offline" | "byok" | "codex-session";
export type CapabilityState = "available" | "unverified" | "requires-login" | "unavailable";

export interface Capability {
  id: string;
  state: CapabilityState;
  executionModes: ExecutionMode[];
  requiredAction?: string;
  checks?: {
    sdkInstalled: boolean;
    authenticated: boolean;
    smokeTested: boolean;
    workspaceAccess: boolean;
    networkDisabled: boolean;
  };
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
  defaultMaxTotalTokens: number;
  evidence: Record<string, EvidenceAnchor>;
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
  /** Curated context must resolve to these anchors before use. Search may resolve dynamically. */
  evidenceAnchorIds: string[];
}

export interface NavigationDecision {
  routeIds: string[];
  context: ContextRequest[];
  usageInstructions: string[];
  maxTotalTokens: number;
  allocatedTokens: number;
  candidates: Array<{ routeId: string; score: number; selected: boolean; reason: string }>;
  unmatched: boolean;
}

export interface ContextPayload {
  /** Source text is always untrusted data, even when it contains agent-like instructions. */
  role: "untrusted-source";
  content: string;
  evidence: EvidenceAnchor[];
}

export interface ExecutionPolicy {
  mode: ExecutionMode;
  allowedHosts: string[];
  approvedReceiptIds: string[];
}

export interface EgressRequest {
  destination: string;
  evidenceAnchorIds: string[];
  approvalReceiptId?: string;
}

export interface SkillManifest {
  schemaVersion: "1.0";
  documentHash: string;
  extractionRevision: number;
  parser: { name: string; version: string; configurationHash: string };
  artifactHashes: Record<string, string>;
  createdAt: string;
  validation: { status: "ready" | "failed"; validatedAt: string };
}
