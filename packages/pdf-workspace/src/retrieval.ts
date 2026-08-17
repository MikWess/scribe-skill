import type { EvidenceAnchor } from "@scribe-skill/core";

import type { CorpusSectionStatus, DocumentPassage } from "./corpus.ts";

export type SearchQuality = DocumentPassage["quality"];
export type SearchReviewState = Exclude<CorpusSectionStatus, "excluded">;
export type VisualFilter = "any" | "present" | "figure" | "table" | "unknown";

export interface SearchQuery {
  documentId: string;
  query: string;
  filters?: {
    sectionIds?: string[];
    pageRange?: { start: number; end: number };
    qualities?: SearchQuality[];
    reviewStates?: SearchReviewState[];
    visual?: VisualFilter;
    extractionRevision?: number;
  };
  limit?: number;
  contextBudget?: { maxCharacters: number };
  sourceRevision: {
    documentHash?: string;
    corpusRevision: number;
    extractionRevision?: number;
  };
}

export interface SearchResult {
  rank: number;
  score: number;
  scoreExplanation: string;
  labels: { passage: "source"; ranking: "derived"; snippet: "derived-from-source" };
  trust: "untrusted-source";
  passage: {
    id: string;
    sectionId: string;
    sourceText: string;
    readingText: string;
    pages: [number, number];
    quality: SearchQuality;
    contentHash: string;
    extractionRevision: number;
    structureRevision: number;
    characterCount: number;
  };
  section: {
    id: string;
    title: string;
    kind: "chapter" | "section";
    status: CorpusSectionStatus;
    order: number;
    pages: [number, number];
  };
  snippet: string;
  matchedTerms: string[];
  preferredEvidenceId: string;
  evidence: EvidenceAnchor[];
}

export interface SearchResponse {
  schemaVersion: "1";
  query: string;
  outcome: "matches" | "no-match" | "budget-exhausted";
  normalizedTerms: string[];
  document: {
    id: string;
    hash: string;
    corpusRevision: number;
    extractionRevision: number;
  };
  appliedFilters: {
    sectionIds: string[];
    pageRange?: { start: number; end: number };
    qualities: SearchQuality[];
    reviewStates: SearchReviewState[];
    visual: VisualFilter;
  };
  contextBudget: {
    unit: "source-text-characters";
    maxCharacters: number;
    usedCharacters: number;
    omittedResultCount: number;
    exhausted: boolean;
    minimumRequiredCharacters?: number;
  };
  results: SearchResult[];
}

const tokenPattern = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

export function normalizedSearchTerms(query: string): string[] {
  const terms = query.normalize("NFKC").toLocaleLowerCase().match(tokenPattern) ?? [];
  return [...new Set(terms)].slice(0, 24);
}

export function ftsSearchExpression(terms: string[]): string {
  const escaped = terms.map((term) => term.replaceAll('"', '""'));
  const anyTerm = escaped.map((term) => `"${term}"`).join(" OR ");
  return escaped.length > 1 ? `"${escaped.join(" ")}" OR ${anyTerm}` : anyTerm;
}

export function matchedSearchTerms(text: string, terms: string[]): string[] {
  const lower = text.normalize("NFKC").toLocaleLowerCase();
  return terms.filter((term) => lower.includes(term));
}

export function plainSearchSnippet(sourceText: string, terms: string[], maximumLength = 260): string {
  const normalized = sourceText.replace(/\s+/g, " ").trim();
  if (normalized.length <= maximumLength) return normalized;
  const lower = normalized.toLocaleLowerCase();
  const firstMatch = terms.reduce((best, term) => {
    const index = lower.indexOf(term);
    return index >= 0 && (best < 0 || index < best) ? index : best;
  }, -1);
  const center = firstMatch >= 0 ? firstMatch : 0;
  const start = Math.max(0, Math.min(center - Math.floor(maximumLength / 3), normalized.length - maximumLength));
  const end = Math.min(normalized.length, start + maximumLength);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end).trim()}${end < normalized.length ? "…" : ""}`;
}

export function evidenceMatchesVisualFilter(evidence: EvidenceAnchor[], visual: VisualFilter): boolean {
  if (visual === "any") return true;
  const regions = evidence.flatMap((anchor) => anchor.region ? [anchor.region.kind] : []);
  if (visual === "unknown") return regions.length === 0;
  if (visual === "present") return regions.length > 0;
  return regions.includes(visual);
}
