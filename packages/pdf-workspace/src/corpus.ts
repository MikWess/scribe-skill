import type { EvidenceAnchor } from "@scribe-skill/core";
import { sha256 } from "@scribe-skill/core";

export type CorpusSectionKind = "chapter" | "section";
export type CorpusSectionOrigin = "detected" | "user";
export type CorpusSectionStatus = "proposed" | "accepted" | "excluded";
export type PassageStatus = "current" | "stale";

export interface DocumentSection {
  id: string;
  documentId: string;
  parentId?: string;
  title: string;
  kind: CorpusSectionKind;
  level: number;
  startPage: number;
  endPage: number;
  startBlockId?: string;
  endBlockId?: string;
  order: number;
  confidence: number;
  origin: CorpusSectionOrigin;
  status: CorpusSectionStatus;
  structureRevision: number;
  rationale: string;
  updatedAt: string;
}

export interface DocumentPassage {
  id: string;
  documentId: string;
  sectionId: string;
  sequence: number;
  sourceText: string;
  readingText: string;
  startPage: number;
  endPage: number;
  startBlockId: string;
  endBlockId: string;
  characterCount: number;
  contentHash: string;
  extractionRevision: number;
  structureRevision: number;
  quality: "good" | "review-needed" | "ocr-required";
  status: PassageStatus;
  evidence: EvidenceAnchor[];
}

export interface CorpusSummary {
  documentId: string;
  structureRevision: number;
  sectionCount: number;
  passageCount: number;
  tocEntryCount: number;
  proposedSectionCount: number;
  acceptedSectionCount: number;
  excludedSectionCount: number;
  reviewRequiredPages: number[];
  ocrRequiredPages: number[];
  ready: boolean;
  blockers: string[];
}

export interface CorpusBlockInput {
  id: string;
  pageNumber: number;
  sourceText: string;
  currentText: string;
  currentOrder: number;
  status: "included" | "excluded" | "rejected";
  confidence: number;
  height: number;
  extractionRevision: number;
}

export interface CorpusPageInput {
  pageNumber: number;
  quality: "good" | "review-needed" | "ocr-required";
  confidence: number;
}

export interface ProposedSection {
  title: string;
  kind: CorpusSectionKind;
  level: number;
  startPage: number;
  endPage: number;
  startBlockId?: string;
  endBlockId?: string;
  confidence: number;
  rationale: string;
}

export interface TocEntry {
  title: string;
  declaredPage: number;
  sourcePage: number;
  blockId: string;
  confidence: number;
}

interface HeadingCandidate {
  block: CorpusBlockInput;
  title: string;
  kind: CorpusSectionKind;
  level: number;
  confidence: number;
  rationale: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2 : sorted[midpoint]!;
}

function titleCaseRatio(text: string): number {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  if (words.length === 0) return 0;
  return words.filter((word) => /^\p{Lu}/u.test(word) || /^\d/.test(word)).length / words.length;
}

function normalizedTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\s+\.{2,}\s*\d+\s*$/, "");
}

const writtenNumber = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty)";
const numberedBookHeading = new RegExp(`^(?:chapter|part)\\s+(?:\\d+|[ivxlcdm]+|${writtenNumber})\\b|^book\\s+(?:\\d+|[ivxlcdm]+|${writtenNumber})\\b`, "i");
const tocLinePattern = /^(.+?)(?:\s*\.{2,}\s*|\s{2,})(\d{1,4})$/;
const namedBookSectionPattern = /^(contents|table of contents|introduction|preface|prologue|foreword|conclusion|epilogue|appendix|notes|endnotes|bibliography|references|acknowledgments|index)\b/i;
const terminalBackMatterPattern = /^(notes|endnotes|bibliography|references|acknowledgments|index)$/i;

function tocPages(blocks: CorpusBlockInput[]): Set<number> {
  const ordered = blocks
    .filter(({ status }) => status === "included")
    .sort((left, right) => left.pageNumber - right.pageNumber || left.currentOrder - right.currentOrder);
  const startPages = ordered
    .filter(({ currentText }) => /^(contents|table of contents)$/i.test(normalizedTitle(currentText)))
    .map(({ pageNumber }) => pageNumber);
  const result = new Set<number>();
  for (const startPage of startPages) {
    result.add(startPage);
    for (let page = startPage + 1; page <= startPage + 12; page += 1) {
      const pageBlocks = ordered.filter(({ pageNumber }) => pageNumber === page);
      if (pageBlocks.length === 0) break;
      const entryCount = pageBlocks.filter(({ currentText }) => tocLinePattern.test(currentText.replace(/\s+/g, " ").trim())).length;
      if (entryCount === 0) break;
      result.add(page);
    }
  }
  return result;
}

function headingCandidate(block: CorpusBlockInput, typicalHeight: number): HeadingCandidate | undefined {
  const title = normalizedTitle(block.currentText);
  const words = title.split(/\s+/).filter(Boolean);
  if (title.length < 2 || title.length > 140 || words.length > 18) return undefined;
  const uppercaseLetters = [...title].filter((character) => /\p{L}/u.test(character));
  const uppercaseRatio = uppercaseLetters.length
    ? uppercaseLetters.filter((character) => character === character.toUpperCase()).length / uppercaseLetters.length
    : 0;
  if (/^[\d\s.]+$/.test(title) || /[.!?…”’")\]]$/.test(title) && uppercaseRatio < 0.82) return undefined;

  const keyword = numberedBookHeading.test(title);
  const namedFrontMatter = namedBookSectionPattern.test(title);
  const sizeRatio = typicalHeight > 0 ? block.height / typicalHeight : 1;
  const titleRatio = titleCaseRatio(title);
  const hasHeadingForm = uppercaseRatio >= 0.82 || titleRatio >= 0.72 || sizeRatio >= 1.28;
  if (keyword && !hasHeadingForm) return undefined;
  const signals: string[] = [];
  let score = 0;

  if (keyword) {
    score += 0.55;
    signals.push("chapter label");
  } else if (namedFrontMatter) {
    score += 0.48;
    signals.push("named book section");
  }
  if (sizeRatio >= 1.65) {
    score += 0.42;
    signals.push("substantially larger type");
  } else if (sizeRatio >= 1.28) {
    score += 0.25;
    signals.push("larger type");
  }
  if (uppercaseRatio >= 0.82 && words.length <= 12) {
    score += 0.2;
    signals.push("uppercase heading form");
  } else if (titleRatio >= 0.72 && words.length <= 12) {
    score += 0.12;
    signals.push("title heading form");
  }
  if (title.length <= 80) score += 0.05;

  if (score < 0.35) return undefined;
  const kind: CorpusSectionKind = keyword || namedFrontMatter || sizeRatio >= 1.65 ? "chapter" : "section";
  const level = kind === "chapter" ? 1 : 2;
  return {
    block,
    title,
    kind,
    level,
    confidence: Math.min(0.96, Math.max(0.45, score)),
    rationale: `Detected from ${signals.join(", ") || "heading form"}.`,
  };
}

function plainContentsBlockIds(blocks: CorpusBlockInput[], typicalHeight: number): Set<string> {
  const ordered = blocks
    .filter(({ status }) => status === "included")
    .sort((left, right) => left.pageNumber - right.pageNumber || left.currentOrder - right.currentOrder);
  const result = new Set<string>();
  for (const [startIndex, start] of ordered.entries()) {
    if (!/^(contents|table of contents)$/i.test(normalizedTitle(start.currentText))) continue;
    const navigationTitles = new Set<string>();
    let navigationHeadingCount = 0;
    let bodyStartIndex = -1;
    for (let index = startIndex + 1; index < ordered.length; index += 1) {
      const block = ordered[index]!;
      if (block.pageNumber > start.pageNumber + 12) break;
      const title = normalizedTitle(block.currentText);
      const key = title.toLocaleLowerCase();
      const sizeRatio = typicalHeight > 0 ? block.height / typicalHeight : 1;
      if (
        navigationHeadingCount >= 2 &&
        sizeRatio >= 1.18 &&
        navigationTitles.has(key) &&
        headingCandidate(block, typicalHeight)
      ) {
        bodyStartIndex = index;
        break;
      }
      if (numberedBookHeading.test(title) || namedBookSectionPattern.test(title)) {
        navigationTitles.add(key);
        navigationHeadingCount += 1;
      }
    }
    if (bodyStartIndex < 0) continue;
    for (let index = startIndex; index < bodyStartIndex; index += 1) result.add(ordered[index]!.id);
  }
  return result;
}

function fallbackTitle(documentName: string): string {
  const withoutExtension = documentName.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
  return withoutExtension || "Book";
}

export function detectTocEntries(blocks: CorpusBlockInput[]): TocEntry[] {
  const ordered = blocks
    .filter(({ status }) => status === "included")
    .sort((left, right) => left.pageNumber - right.pageNumber || left.currentOrder - right.currentOrder);
  const contentsPages = tocPages(ordered);
  return ordered.flatMap((block) => {
    if (!contentsPages.has(block.pageNumber)) return [];
    const text = block.currentText.replace(/\s+/g, " ").trim();
    const match = text.match(tocLinePattern);
    if (!match) return [];
    const title = match[1]!.trim();
    const declaredPage = Number(match[2]);
    if (!title || !Number.isSafeInteger(declaredPage) || declaredPage < 1) return [];
    return [{ title, declaredPage, sourcePage: block.pageNumber, blockId: block.id, confidence: 0.78 }];
  });
}

export function proposeCorpusSections(
  documentId: string,
  documentName: string,
  pageCount: number,
  blocks: CorpusBlockInput[],
): ProposedSection[] {
  const included = blocks
    .filter((block) => block.status === "included")
    .sort((left, right) => left.pageNumber - right.pageNumber || left.currentOrder - right.currentOrder);
  if (included.length === 0) {
    return [{
      title: fallbackTitle(documentName),
      kind: "chapter",
      level: 1,
      startPage: 1,
      endPage: pageCount,
      confidence: 0,
      rationale: "No readable text is available; OCR is required before chapter detection.",
    }];
  }

  const typicalHeight = median(included.map(({ height }) => height).filter((height) => height > 0));
  const candidates = included.flatMap((block) => {
    const candidate = headingCandidate(block, typicalHeight);
    return candidate ? [candidate] : [];
  });
  const contentsPages = tocPages(included);
  const plainContentsBlocks = plainContentsBlockIds(included, typicalHeight);
  const tocEntries = detectTocEntries(included);
  let headings = candidates.filter(({ block, title }) => {
    if (!contentsPages.has(block.pageNumber) && !plainContentsBlocks.has(block.id)) return true;
    return /^(contents|table of contents)$/i.test(title);
  });

  let insideTerminalBackMatter = false;
  const terminalBackMatterStartPage = Math.max(1, Math.floor(pageCount * 0.6));
  headings = headings.filter(({ block, title }) => {
    if (block.pageNumber >= terminalBackMatterStartPage && terminalBackMatterPattern.test(title)) {
      insideTerminalBackMatter = true;
      return true;
    }
    return !insideTerminalBackMatter;
  });

  const contentHeadings = headings.filter(({ title }) => !/^(contents|table of contents)$/i.test(title));
  if (contentHeadings.length === 0 && tocEntries.length > 0) {
    const inferred = tocEntries
      .filter(({ declaredPage }) => declaredPage <= pageCount)
      .map((entry): HeadingCandidate | undefined => {
        const block = included.find(({ pageNumber }) => pageNumber === entry.declaredPage);
        return block ? {
          block,
          title: entry.title,
          kind: numberedBookHeading.test(entry.title) ? "chapter" : "section",
          level: numberedBookHeading.test(entry.title) ? 1 : 2,
          confidence: entry.confidence,
          rationale: `Proposed from a table-of-contents entry on PDF page ${entry.sourcePage}; verify printed and PDF page alignment.`,
        } : undefined;
      })
      .filter((entry): entry is HeadingCandidate => Boolean(entry));
    headings = [...headings, ...inferred];
  }

  if (headings.length === 0) {
    return [{
      title: fallbackTitle(documentName),
      kind: "chapter",
      level: 1,
      startPage: 1,
      endPage: pageCount,
      startBlockId: included[0]!.id,
      endBlockId: included.at(-1)!.id,
      confidence: 0.35,
      rationale: "No reliable headings were detected; one reviewable whole-book chapter was proposed.",
    }];
  }

  const positions = new Map(included.map((block, index) => [block.id, index]));
  const proposals = headings.map((heading, index): ProposedSection => {
    const startIndex = positions.get(heading.block.id)!;
    const nextHeading = headings[index + 1];
    const nextIndex = nextHeading ? positions.get(nextHeading.block.id)! : included.length;
    const endBlock = included[Math.max(startIndex, nextIndex - 1)]!;
    return {
      title: heading.title,
      kind: heading.kind,
      level: heading.level,
      startPage: heading.block.pageNumber,
      endPage: endBlock.pageNumber,
      startBlockId: heading.block.id,
      endBlockId: endBlock.id,
      confidence: heading.confidence,
      rationale: heading.rationale,
    };
  });

  const first = headings[0]!;
  const firstIndex = positions.get(first.block.id)!;
  if (firstIndex > 0) {
    const opening = included.slice(0, firstIndex);
    proposals.unshift({
      title: "Opening pages",
      kind: "section",
      level: 1,
      startPage: opening[0]!.pageNumber,
      endPage: opening.at(-1)!.pageNumber,
      startBlockId: opening[0]!.id,
      endBlockId: opening.at(-1)!.id,
      confidence: 0.45,
      rationale: "Readable material appears before the first detected heading and requires review.",
    });
  }

  return proposals;
}

export interface PassageDraft {
  id: string;
  sectionId: string;
  sequence: number;
  sourceText: string;
  readingText: string;
  startPage: number;
  endPage: number;
  startBlockId: string;
  endBlockId: string;
  characterCount: number;
  contentHash: string;
  extractionRevision: number;
  structureRevision: number;
  quality: DocumentPassage["quality"];
  evidence: EvidenceAnchor[];
}

export interface PassageBlockIndex {
  ordered: CorpusBlockInput[];
  positions: Map<string, number>;
  pages: Array<{ pageNumber: number; first: number; last: number }>;
}

export function indexPassageBlocks(blocks: CorpusBlockInput[]): PassageBlockIndex {
  const ordered = blocks
    .filter((block) => block.status === "included")
    .sort((left, right) => left.pageNumber - right.pageNumber || left.currentOrder - right.currentOrder);
  const positions = new Map(ordered.map((block, index) => [block.id, index]));
  const pages: PassageBlockIndex["pages"] = [];
  for (const [index, block] of ordered.entries()) {
    const current = pages.at(-1);
    if (current?.pageNumber === block.pageNumber) current.last = index;
    else pages.push({ pageNumber: block.pageNumber, first: index, last: index });
  }
  return { ordered, positions, pages };
}

export function buildPassageDrafts(
  documentId: string,
  section: DocumentSection,
  blocks: CorpusBlockInput[],
  pageQuality: (pageNumber: number) => DocumentPassage["quality"],
  evidenceForBlock: (blockId: string) => EvidenceAnchor,
  maxCharacters = 1_200,
  prepared = indexPassageBlocks(blocks),
): PassageDraft[] {
  const { ordered, positions, pages } = prepared;
  const explicitStartIndex = section.startBlockId ? positions.get(section.startBlockId) ?? -1 : -1;
  const startIndex = explicitStartIndex >= 0
    ? explicitStartIndex
    : pages.find(({ pageNumber }) => pageNumber >= section.startPage)?.first ?? -1;
  const explicitEndIndex = section.endBlockId ? positions.get(section.endBlockId) ?? -1 : -1;
  const endIndex = explicitEndIndex >= 0
    ? explicitEndIndex
    : pages.findLast(({ pageNumber }) => pageNumber <= section.endPage)?.last ?? -1;
  if (startIndex < 0 || endIndex < startIndex) return [];

  const scoped = ordered.slice(startIndex, endIndex + 1);
  const groups: CorpusBlockInput[][] = [];
  let current: CorpusBlockInput[] = [];
  let currentCharacters = 0;
  for (const block of scoped) {
    const separator = current.length ? 2 : 0;
    if (current.length && currentCharacters + separator + block.currentText.length > maxCharacters) {
      groups.push(current);
      current = [];
      currentCharacters = 0;
    }
    current.push(block);
    currentCharacters += (current.length > 1 ? 2 : 0) + block.currentText.length;
  }
  if (current.length) groups.push(current);

  return groups.map((group, sequence) => {
    const sourceText = group.map(({ sourceText }) => sourceText).join("\n\n");
    const readingText = group.map(({ currentText }) => currentText).join("\n\n");
    const start = group[0]!;
    const end = group.at(-1)!;
    const qualities = [...new Set(group.map(({ pageNumber }) => pageQuality(pageNumber)))];
    const quality = qualities.includes("ocr-required")
      ? "ocr-required"
      : qualities.includes("review-needed") ? "review-needed" : "good";
    const identity = sha256(JSON.stringify({
      documentId,
      sectionId: section.id,
      blockIds: group.map(({ id }) => id),
      readingText,
    }));
    return {
      id: `passage-${identity.slice("sha256:".length, "sha256:".length + 24)}`,
      sectionId: section.id,
      sequence,
      sourceText,
      readingText,
      startPage: start.pageNumber,
      endPage: end.pageNumber,
      startBlockId: start.id,
      endBlockId: end.id,
      characterCount: readingText.length,
      contentHash: sha256(sourceText),
      extractionRevision: Math.max(...group.map(({ extractionRevision }) => extractionRevision)),
      structureRevision: section.structureRevision,
      quality,
      evidence: group.map(({ id }) => evidenceForBlock(id)),
    };
  });
}
