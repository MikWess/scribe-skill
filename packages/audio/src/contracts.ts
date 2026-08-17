import type { EvidenceAnchor } from "@scribe-skill/core";

export type TimingQuality = "exact-character" | "exact-word" | "estimated-sentence" | "none";
export type AudioJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface VoiceCapability {
  provider: "device" | "openai" | "elevenlabs";
  available: boolean;
  requiresApiKey: boolean;
  timingQuality: TimingQuality;
  streaming: boolean;
  maxCharacters?: number;
  reason?: string;
}

export interface NarrationArtifactRecord {
  jobId: string;
  contentHash: string;
  mimeType: string;
  byteLength: number;
  timingQuality: TimingQuality;
  timings: TimingSpan[];
  disclosure: string;
  createdAt: string;
}

export interface AudioJob {
  id: string;
  cacheKey: string;
  status: AudioJobStatus;
  request: NarrationRequest;
  attempts: number;
  error?: string;
  artifact?: NarrationArtifactRecord;
  createdAt: string;
  updatedAt: string;
}

export interface NarrationScript {
  id: string;
  sectionId: string;
  revision: number;
  sourceText: string;
  readingText: string;
  /** Hash of the editable reading copy at the time this script was created. */
  readingSourceHash?: string;
  evidence: EvidenceAnchor[];
  createdAt: string;
}

export interface NarrationRequest {
  script: NarrationScript;
  provider: VoiceCapability["provider"];
  voice: string;
  model?: string;
  instructions?: string;
  format: "mp3" | "wav";
}

export interface TimingSpan {
  text: string;
  startSeconds: number;
  endSeconds: number;
  characterRange: { start: number; end: number };
}

export interface NarrationArtifact {
  mimeType: string;
  bytes: Uint8Array;
  timingQuality: TimingQuality;
  timings: TimingSpan[];
  disclosure: string;
}

export interface VoiceProvider {
  capability(): VoiceCapability;
  synthesize(request: NarrationRequest, signal?: AbortSignal): Promise<NarrationArtifact>;
}

export type VoiceProviderRegistry = Partial<Record<Exclude<VoiceCapability["provider"], "device">, VoiceProvider>>;
