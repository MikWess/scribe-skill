import { sha256 } from "@scribe-skill/core";

import type { NarrationRequest, NarrationScript } from "./contracts.ts";

export function createNarrationScript(
  sectionId: string,
  sourceText: string,
  readingText: string,
  evidence: NarrationScript["evidence"],
  revision = 1,
): NarrationScript {
  if (!sectionId || !sourceText.trim() || !readingText.trim() || evidence.length === 0) {
    throw new Error("Narration scripts require a section, source, reading text, and evidence");
  }
  return {
    id: `script-${sha256(JSON.stringify({ sectionId, revision, sourceText, readingText, evidence })).slice("sha256:".length)}`,
    sectionId,
    revision,
    sourceText,
    readingText,
    evidence,
    createdAt: new Date().toISOString(),
  };
}

export function narrationCacheKey(request: NarrationRequest): string {
  return sha256(JSON.stringify({
    scriptId: request.script.id,
    revision: request.script.revision,
    sourceText: request.script.sourceText,
    readingText: request.script.readingText,
    evidence: request.script.evidence,
    provider: request.provider,
    voice: request.voice,
    model: request.model,
    instructions: request.instructions,
    format: request.format,
  }));
}
