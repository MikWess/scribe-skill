import type {
  NarrationArtifactRecord,
  NarrationRequest,
  NarrationScript,
  TimingQuality,
  VoiceCapability,
} from "@scribe-skill/audio";

export type SourceQuality = "good" | "review-needed" | "ocr-required";
export type RightsScope = "private-listening" | "redistribution";
export type AudiobookState =
  | "draft"
  | "approved"
  | "running"
  | "paused"
  | "needs-review"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget-exhausted"
  | "stale";
export type ProductionChunkState =
  | "planned"
  | "running"
  | "generated"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "stale";

export interface RightsAttestation {
  affirmed: boolean;
  scope: RightsScope;
  attestor: "user" | "agent";
  statementVersion: "2026-08-15";
  affirmedAt: string;
}

export interface PricingBasis {
  kind: "user-supplied-per-million-characters";
  usdPerMillionCharacters: number;
  checkedAt: string;
  note: string;
}

export interface ProductionBudget {
  maxCostUsd: number;
  maxCharacters: number;
  maxProviderRequests: number;
}

export interface PronunciationRule {
  source: string;
  spoken: string;
}

export interface AudiobookSectionInput {
  sectionId: string;
  title: string;
  startPage: number;
  endPage: number;
  quality: SourceQuality;
  qualityApproved: boolean;
  script: NarrationScript;
}

export interface CreateAudiobookPlanInput {
  documentId: string;
  documentHash: string;
  extractionRevision: number;
  corpusRevision: number;
  sections: AudiobookSectionInput[];
  provider: Exclude<VoiceCapability["provider"], "device">;
  providerHost: string;
  voice: string;
  model?: string;
  instructions?: string;
  format: "mp3" | "wav";
  timingQuality: TimingQuality;
  maxChunkCharacters: number;
  pricing: PricingBasis;
  budget: ProductionBudget;
  rights: RightsAttestation;
  pronunciation: PronunciationRule[];
}

export interface PlanBlocker {
  code: "rights-required" | "ocr-required" | "quality-approval-required" | "budget" | "characters" | "requests" | "chunking";
  message: string;
  sectionId?: string;
}

export interface QcCheck {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface ChunkQc {
  state: "pending" | "passed" | "warning" | "failed" | "waived";
  checks: QcCheck[];
  reviewedBy?: "user" | "agent";
  reviewedAt?: string;
  reviewReason?: string;
}

export interface ProductionChunk {
  id: string;
  sequence: number;
  sectionId: string;
  sectionTitle: string;
  sectionSequence: number;
  chunkSequence: number;
  startPage: number;
  endPage: number;
  sourceScriptId: string;
  sourceScriptRevision: number;
  evidenceScope: "exact" | "section";
  readingCharacterRange: { start: number; end: number };
  sourceCharacterRange?: { start: number; end: number };
  evidenceIds: string[];
  request: NarrationRequest;
  estimatedCostUsd: number;
  state: ProductionChunkState;
  dispatches: number;
  reused: boolean;
  error?: string;
  audioJobId?: string;
  artifact?: NarrationArtifactRecord;
  priorArtifacts?: Array<{
    artifact: NarrationArtifactRecord;
    qc: ChunkQc;
    reason: string;
    supersededAt: string;
  }>;
  qc: ChunkQc;
}

export interface SourceReviewReceipt {
  sectionId: string;
  title: string;
  pages: [number, number];
  quality: SourceQuality;
  qualityApproved: boolean;
}

export interface ApprovalReceipt {
  id: string;
  planHash: string;
  provider: CreateAudiobookPlanInput["provider"];
  host: string;
  sectionIds: string[];
  evidenceIds: string[];
  characters: number;
  estimatedCostUsd: number;
  approvedAt: string;
}

export interface AudiobookRun {
  schemaVersion: "1";
  id: string;
  revision: number;
  planHash: string;
  idempotencyKey: string;
  requestHash: string;
  state: AudiobookState;
  documentId: string;
  documentHash: string;
  extractionRevision: number;
  corpusRevision: number;
  provider: CreateAudiobookPlanInput["provider"];
  providerHost: string;
  voice: string;
  model?: string;
  instructions?: string;
  format: "mp3" | "wav";
  timingQuality: TimingQuality;
  maxChunkCharacters: number;
  pricing: PricingBasis;
  budget: ProductionBudget;
  rights: RightsAttestation;
  pronunciation: PronunciationRule[];
  sourceReview: SourceReviewReceipt[];
  blockers: PlanBlocker[];
  totalCharacters: number;
  estimatedCostUsd: number;
  committedCostUsd: number;
  providerRequests: number;
  chunks: ProductionChunk[];
  receipt?: ApprovalReceipt;
  export?: { path: string; manifestHash: string; createdAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface ExportedAudiobookManifest {
  schemaVersion: "1";
  audiobookId: string;
  planHash: string;
  document: { id: string; hash: string; extractionRevision: number };
  rights: RightsAttestation;
  receipt: ApprovalReceipt;
  provider: { id: AudiobookRun["provider"]; host: string; voice: string; model?: string; format: "mp3" | "wav"; timingQuality: TimingQuality };
  budget: ProductionBudget & { estimatedCostUsd: number; committedCostUsd: number; providerRequests: number; pricing: PricingBasis };
  pronunciation: PronunciationRule[];
  sourceReview: SourceReviewReceipt[];
  authorizedUse: {
    purpose: "private-backup" | "redistribution";
    attestor: "user" | "agent";
    affirmedAt: string;
    notice: string;
  };
  chunks: Array<{
    id: string;
    sequence: number;
    sectionId: string;
    sectionTitle: string;
    sectionSequence: number;
    chunkSequence: number;
    pages: [number, number];
    sourceScriptId: string;
    sourceScriptRevision: number;
    evidenceScope: "exact" | "section";
    readingCharacterRange: { start: number; end: number };
    sourceCharacterRange?: { start: number; end: number };
    evidenceIds: string[];
    evidence: NarrationScript["evidence"];
    readingText: string;
    sourceTextHash: string;
    readingTextHash: string;
    artifact: { file: string; contentHash: string; mimeType: string; byteLength: number };
    priorArtifacts: Array<{
      contentHash: string;
      mimeType: string;
      byteLength: number;
      qc: ChunkQc;
      reason: string;
      supersededAt: string;
    }>;
    timingQuality: TimingQuality;
    qc: ChunkQc;
    disclosure: string;
    reused: boolean;
  }>;
  createdAt: string;
}
