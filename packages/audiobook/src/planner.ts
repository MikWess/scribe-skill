import { createNarrationScript, narrationCacheKey } from "@scribe-skill/audio";
import { sha256 } from "@scribe-skill/core";

import type {
  AudiobookRun,
  CreateAudiobookPlanInput,
  PlanBlocker,
  ProductionChunk,
  PronunciationRule,
} from "./contracts.ts";

interface TextChunk {
  text: string;
  range: { start: number; end: number };
}

function exactEvidenceForRange(script: CreateAudiobookPlanInput["sections"][number]["script"], range: { start: number; end: number }) {
  const selected = [] as typeof script.evidence;
  let sourceCursor = 0;
  for (const anchor of script.evidence) {
    const anchorLength = anchor.characterRange.end - anchor.characterRange.start;
    const segmentStart = sourceCursor;
    const segmentEnd = segmentStart + anchorLength;
    const overlapStart = Math.max(range.start, segmentStart);
    const overlapEnd = Math.min(range.end, segmentEnd);
    if (overlapStart < overlapEnd) {
      const localStart = anchor.characterRange.start + overlapStart - segmentStart;
      const localEnd = anchor.characterRange.start + overlapEnd - segmentStart;
      selected.push({
        ...anchor,
        id: `${anchor.id}:production:${localStart}-${localEnd}`,
        characterRange: { start: localStart, end: localEnd },
        contentHash: sha256(script.sourceText.slice(overlapStart, overlapEnd)),
      });
    }
    sourceCursor = segmentEnd + 2;
  }
  return selected;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function replaceBounded(text: string, source: string, spoken: string, maxCharacters: number): string {
  let cursor = 0;
  let next = "";
  while (cursor < text.length) {
    const match = text.indexOf(source, cursor);
    const end = match < 0 ? text.length : match;
    const addition = text.slice(cursor, end) + (match < 0 ? "" : spoken);
    if (next.length + addition.length > maxCharacters) {
      throw new Error(`Pronunciation expansion exceeds the provider limit of ${maxCharacters.toLocaleString()} characters`);
    }
    next += addition;
    if (match < 0) break;
    cursor = match + source.length;
  }
  return next;
}

function applyPronunciation(text: string, rules: PronunciationRule[], maxCharacters: number): string {
  return rules.reduce(
    (current, rule) => replaceBounded(current, rule.source, rule.spoken, maxCharacters),
    text,
  );
}

export function splitNarrationText(text: string, maxCharacters: number): TextChunk[] {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 32) throw new Error("Chunk size must be an integer of at least 32 characters");
  const chunks: TextChunk[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    if (cursor >= text.length) break;
    const hardEnd = Math.min(text.length, cursor + maxCharacters);
    let end = hardEnd;
    if (hardEnd < text.length) {
      const candidate = text.slice(cursor, hardEnd + 1);
      const boundaries = [...candidate.matchAll(/(?:[.!?]["')\]]*\s+|\n\s*\n)/g)];
      const sentenceEnd = boundaries.at(-1);
      if (sentenceEnd && sentenceEnd.index !== undefined && sentenceEnd.index + sentenceEnd[0].length >= Math.floor(maxCharacters * 0.4)) {
        end = cursor + sentenceEnd.index + sentenceEnd[0].length;
      } else {
        const whitespace = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\n"), candidate.lastIndexOf("\t"));
        if (whitespace <= 0) throw new Error(`An indivisible narration span exceeds ${maxCharacters} characters near offset ${cursor}`);
        end = cursor + whitespace + 1;
      }
    }
    const raw = text.slice(cursor, end);
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) chunks.push({ text: trimmed, range: { start: cursor + leading, end: cursor + leading + trimmed.length } });
    cursor = end;
  }
  return chunks;
}

export function createAudiobookPlan(input: CreateAudiobookPlanInput, idempotencyKey: string): AudiobookRun {
  if (!idempotencyKey.trim()) throw new Error("An idempotency key is required");
  if (input.sections.length === 0) throw new Error("Select at least one section");
  if (new Set(input.sections.map(({ sectionId }) => sectionId)).size !== input.sections.length) {
    throw new Error("Each selected section must be unique");
  }
  if (!input.voice.trim()) throw new Error("A provider voice is required");
  if (!Number.isFinite(input.pricing.usdPerMillionCharacters) || input.pricing.usdPerMillionCharacters <= 0) {
    throw new Error("A positive user-supplied provider rate is required for budget enforcement");
  }
  if (!Number.isFinite(input.budget.maxCostUsd) || input.budget.maxCostUsd <= 0) throw new Error("A positive hard cost ceiling is required");
  if (!Number.isSafeInteger(input.budget.maxCharacters) || input.budget.maxCharacters < 1) throw new Error("A positive character ceiling is required");
  if (!Number.isSafeInteger(input.budget.maxProviderRequests) || input.budget.maxProviderRequests < 1) throw new Error("A positive provider-request ceiling is required");
  if (input.pronunciation.length > 100) throw new Error("At most 100 pronunciation rules are allowed");
  for (const rule of input.pronunciation) {
    if (!rule.source.trim() || !rule.spoken.trim()) throw new Error("Pronunciation rules require source and spoken text");
    if (rule.source.length > 256 || rule.spoken.length > 256) throw new Error("Pronunciation rule fields are limited to 256 characters");
  }

  const blockers: PlanBlocker[] = [];
  if (!input.rights.affirmed) blockers.push({ code: "rights-required", message: "Rights or permission must be affirmed before provider egress" });
  const chunks: ProductionChunk[] = [];
  let sequence = 0;
  for (const [sectionSequence, section] of input.sections.entries()) {
    if (section.quality === "ocr-required") {
      blockers.push({ code: "ocr-required", sectionId: section.sectionId, message: `${section.title} requires OCR or source repair before production` });
    }
    if (section.quality === "review-needed" && !section.qualityApproved) {
      blockers.push({ code: "quality-approval-required", sectionId: section.sectionId, message: `${section.title} needs explicit extraction-quality approval` });
    }
    let textChunks: TextChunk[] = [];
    try {
      textChunks = splitNarrationText(section.script.readingText, input.maxChunkCharacters);
    } catch (error) {
      blockers.push({ code: "chunking", sectionId: section.sectionId, message: error instanceof Error ? error.message : "Section could not be chunked" });
    }
    let sourceCursor = 0;
    for (const [chunkSequence, chunk] of textChunks.entries()) {
      let spokenText: string;
      try {
        spokenText = applyPronunciation(chunk.text, input.pronunciation, input.maxChunkCharacters);
      } catch (error) {
        blockers.push({
          code: "chunking",
          sectionId: section.sectionId,
          message: error instanceof Error ? error.message : "Pronunciation expansion exceeds the provider limit",
        });
        continue;
      }
      const exactSourceStart = section.script.sourceText.indexOf(chunk.text, sourceCursor);
      const exactSourceRange = exactSourceStart >= 0
        ? { start: exactSourceStart, end: exactSourceStart + chunk.text.length }
        : undefined;
      const exactEvidence = exactSourceRange ? exactEvidenceForRange(section.script, exactSourceRange) : [];
      const evidenceScope = exactSourceRange && exactEvidence.length > 0 ? "exact" : "section";
      if (exactSourceRange) sourceCursor = exactSourceRange.end;
      const generatedScript = createNarrationScript(
        `${section.sectionId}:production:${chunkSequence + 1}`,
        evidenceScope === "exact" ? section.script.sourceText.slice(exactSourceRange!.start, exactSourceRange!.end) : section.script.sourceText,
        spokenText,
        evidenceScope === "exact" ? exactEvidence : section.script.evidence,
        1,
      );
      const chunkScript = { ...generatedScript, createdAt: section.script.createdAt };
      const request = {
        script: chunkScript,
        provider: input.provider,
        voice: input.voice,
        model: input.model,
        instructions: input.instructions,
        format: input.format,
      } as const;
      const estimatedCostUsd = Number(((spokenText.length / 1_000_000) * input.pricing.usdPerMillionCharacters).toFixed(6));
      const id = `production-${narrationCacheKey(request).slice("sha256:".length)}`;
      chunks.push({
        id,
        sequence,
        sectionId: section.sectionId,
        sectionTitle: section.title,
        sectionSequence,
        chunkSequence,
        startPage: section.startPage,
        endPage: section.endPage,
        sourceScriptId: section.script.id,
        sourceScriptRevision: section.script.revision,
        evidenceScope,
        readingCharacterRange: chunk.range,
        sourceCharacterRange: evidenceScope === "exact" ? exactSourceRange : undefined,
        evidenceIds: chunkScript.evidence.map(({ id: evidenceId }) => evidenceId),
        request,
        estimatedCostUsd,
        state: "planned",
        dispatches: 0,
        reused: false,
        qc: { state: "pending", checks: [] },
      });
      sequence += 1;
    }
  }
  const totalCharacters = chunks.reduce((total, chunk) => total + chunk.request.script.readingText.length, 0);
  const estimatedCostUsd = Number(chunks.reduce((total, chunk) => total + chunk.estimatedCostUsd, 0).toFixed(6));
  if (totalCharacters > input.budget.maxCharacters) blockers.push({ code: "characters", message: `Plan has ${totalCharacters.toLocaleString()} characters, above the ${input.budget.maxCharacters.toLocaleString()} ceiling` });
  if (chunks.length > input.budget.maxProviderRequests) blockers.push({ code: "requests", message: `Plan needs ${chunks.length} provider requests, above the ${input.budget.maxProviderRequests} ceiling` });
  if (estimatedCostUsd > input.budget.maxCostUsd) blockers.push({ code: "budget", message: `Estimated cost $${estimatedCostUsd.toFixed(4)} exceeds the $${input.budget.maxCostUsd.toFixed(4)} hard ceiling` });

  const sourceReview = input.sections.map((section) => ({
    sectionId: section.sectionId,
    title: section.title,
    pages: [section.startPage, section.endPage] as [number, number],
    quality: section.quality,
    qualityApproved: section.qualityApproved,
  }));
  const planShape = {
    documentId: input.documentId,
    documentHash: input.documentHash,
    extractionRevision: input.extractionRevision,
    provider: input.provider,
    providerHost: input.providerHost,
    voice: input.voice,
    model: input.model,
    instructions: input.instructions,
    format: input.format,
    timingQuality: input.timingQuality,
    maxChunkCharacters: input.maxChunkCharacters,
    pricing: input.pricing,
    budget: input.budget,
    rights: input.rights,
    pronunciation: input.pronunciation,
    sourceReview,
    chunks: chunks.map(({ id, sectionId, sourceScriptId, evidenceScope, readingCharacterRange, sourceCharacterRange, request, estimatedCostUsd: cost }) => ({
      id, sectionId, sourceScriptId, evidenceScope, readingCharacterRange, sourceCharacterRange, request, estimatedCostUsd: cost,
    })),
  };
  const planHash = sha256(stableJson(planShape));
  const now = new Date().toISOString();
  return {
    schemaVersion: "1",
    id: `audiobook-${planHash.slice("sha256:".length)}`,
    revision: 1,
    planHash,
    idempotencyKey,
    requestHash: sha256(stableJson(input)),
    state: "draft",
    ...planShape,
    blockers,
    totalCharacters,
    estimatedCostUsd,
    committedCostUsd: 0,
    providerRequests: 0,
    chunks,
    createdAt: now,
    updatedAt: now,
  };
}
