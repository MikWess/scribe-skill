import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EvidenceAnchor } from "@scribe-skill/core";
import { sha256 } from "@scribe-skill/core";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  buildPassageDrafts,
  detectTocEntries,
  indexPassageBlocks,
  proposeCorpusSections,
  type CorpusSectionKind,
  type CorpusSectionStatus,
  type CorpusSummary,
  type DocumentPassage,
  type DocumentSection,
  type ProposedSection,
} from "./corpus.ts";
import {
  inquiryRoute,
  inquiryRoutes,
  nextInquiryPrompt,
  type AnswerInquiryInput,
  type CreateInquiryInput,
  type InquiryEvidence,
  type InquiryResponseKind,
  type InquiryRoute,
  type InquirySession,
  type InquiryStep,
} from "./inquiry.ts";
import {
  evidenceMatchesVisualFilter,
  ftsSearchExpression,
  matchedSearchTerms,
  normalizedSearchTerms,
  plainSearchSnippet,
  type SearchQuality,
  type SearchQuery,
  type SearchReviewState,
  type SearchResponse,
  type SearchResult,
  type VisualFilter,
} from "./retrieval.ts";

export type PageQuality = "good" | "review-needed" | "ocr-required";
export type BlockStatus = "included" | "excluded" | "rejected";

export interface ImportedDocument {
  id: string;
  documentHash: string;
  originalName: string;
  assetPath: string;
  pageCount: number;
  extractionRevision: number;
  corpusRevision: number;
}

export interface ExtractedPage {
  documentId: string;
  pageNumber: number;
  width: number;
  height: number;
  confidence: number;
  quality: PageQuality;
  renderHash?: string;
}

export interface PageInspection {
  page: ExtractedPage;
  blocks: ExtractedBlock[];
  renderPath: string;
  renderHash: string;
}

export class WorkspaceIntegrityError extends Error {
  override name = "WorkspaceIntegrityError";
}

export class CorpusRevisionConflictError extends Error {
  override name = "CorpusRevisionConflictError";
  readonly documentId: string;
  readonly expectedRevision: number;
  readonly currentRevision: number;

  constructor(documentId: string, expectedRevision: number, currentRevision: number) {
    super(`Corpus revision ${expectedRevision} is stale; current revision is ${currentRevision}`);
    this.documentId = documentId;
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

export class SourceRevisionConflictError extends Error {
  override name = "SourceRevisionConflictError";
  readonly documentId: string;

  constructor(documentId: string, message: string) {
    super(message);
    this.documentId = documentId;
  }
}

export interface ExtractedBlock {
  id: string;
  documentId: string;
  pageNumber: number;
  sourceText: string;
  currentText: string;
  originalOrder: number;
  currentOrder: number;
  status: BlockStatus;
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
  contentHash: string;
  extractionRevision: number;
}

export interface BlockEdit {
  id: number;
  blockId: string;
  previousText: string;
  nextText: string;
  previousOrder: number;
  nextOrder: number;
  previousStatus: BlockStatus;
  nextStatus: BlockStatus;
  note: string;
  createdAt: string;
}

export interface ReadingProgress {
  documentId: string;
  pageNumber: number;
  blockId?: string;
  updatedAt: string;
}

export interface Annotation {
  id: number;
  documentId: string;
  blockId: string;
  kind: "note" | "highlight";
  authorship: "user" | "source" | "model";
  content: string;
  createdAt: string;
}

interface RawBlock {
  text: string;
  order: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

function fileHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function documentId(hash: string): string {
  return `doc-${hash.slice("sha256:".length, "sha256:".length + 16)}`;
}

function pageQuality(blocks: RawBlock[]): { quality: PageQuality; confidence: number } {
  const characters = blocks.reduce((total, block) => total + block.text.length, 0);
  if (characters === 0) return { quality: "ocr-required", confidence: 0 };
  const replacementCharacters = blocks.reduce(
    (total, block) => total + [...block.text].filter((character) => character === "�").length,
    0,
  );
  const leftColumn = blocks.filter(({ x }) => x < 0.45).length;
  const rightColumn = blocks.filter(({ x }) => x > 0.5).length;
  if (characters < 20 || replacementCharacters / characters > 0.01 || (leftColumn > 1 && rightColumn > 1)) {
    return { quality: "review-needed", confidence: 0.65 };
  }
  return { quality: "good", confidence: 0.95 };
}

function deterministicReadingOrder(blocks: RawBlock[]): RawBlock[] {
  const byPosition = (left: RawBlock, right: RawBlock) => left.y - right.y || left.x - right.x || left.order - right.order;
  const left = blocks.filter(({ x }) => x < 0.46);
  const right = blocks.filter(({ x }) => x > 0.5);
  if (left.length < 2 || right.length < 2) return [...blocks].sort(byPosition);

  const spanning = blocks.filter(({ width, x }) => width >= 0.62 || (x < 0.46 && x + width > 0.54));
  const spanningIds = new Set(spanning.map(({ order }) => order));
  const columnBlocks = blocks.filter(({ order }) => !spanningIds.has(order));
  const firstColumnY = Math.min(...columnBlocks.map(({ y }) => y));
  const headers = spanning.filter(({ y }) => y <= firstColumnY).sort(byPosition);
  const footers = spanning.filter(({ y }) => y > firstColumnY).sort(byPosition);
  return [
    ...headers,
    ...columnBlocks.filter(({ x }) => x < 0.5).sort(byPosition),
    ...columnBlocks.filter(({ x }) => x >= 0.5).sort(byPosition),
    ...footers,
  ];
}

function normalizeBlock(row: Record<string, unknown>): ExtractedBlock {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    pageNumber: Number(row.page_number),
    sourceText: String(row.source_text),
    currentText: String(row.current_text),
    originalOrder: Number(row.original_order),
    currentOrder: Number(row.current_order),
    status: String(row.status) as BlockStatus,
    confidence: Number(row.confidence),
    boundingBox: {
      x: Number(row.x),
      y: Number(row.y),
      width: Number(row.width),
      height: Number(row.height),
    },
    contentHash: String(row.content_hash),
    extractionRevision: Number(row.extraction_revision),
  };
}

function normalizeSection(row: Record<string, unknown>): DocumentSection {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    parentId: row.parent_id ? String(row.parent_id) : undefined,
    title: String(row.title),
    kind: String(row.kind) as CorpusSectionKind,
    level: Number(row.level),
    startPage: Number(row.start_page),
    endPage: Number(row.end_page),
    startBlockId: row.start_block_id ? String(row.start_block_id) : undefined,
    endBlockId: row.end_block_id ? String(row.end_block_id) : undefined,
    order: Number(row.section_order),
    confidence: Number(row.confidence),
    origin: String(row.origin) as DocumentSection["origin"],
    status: String(row.status) as CorpusSectionStatus,
    structureRevision: Number(row.structure_revision),
    rationale: String(row.rationale),
    updatedAt: String(row.updated_at),
  };
}

function normalizePassage(row: Record<string, unknown>): DocumentPassage {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    sectionId: String(row.section_id),
    sequence: Number(row.passage_sequence),
    sourceText: String(row.source_text),
    readingText: String(row.reading_text),
    startPage: Number(row.start_page),
    endPage: Number(row.end_page),
    startBlockId: String(row.start_block_id),
    endBlockId: String(row.end_block_id),
    characterCount: Number(row.character_count),
    contentHash: String(row.content_hash),
    extractionRevision: Number(row.extraction_revision),
    structureRevision: Number(row.structure_revision),
    quality: String(row.quality) as DocumentPassage["quality"],
    status: String(row.status) as DocumentPassage["status"],
    evidence: JSON.parse(String(row.evidence_json)) as EvidenceAnchor[],
  };
}

function normalizeInquiryStep(row: Record<string, unknown>): InquiryStep {
  return {
    id: String(row.id),
    sequence: Number(row.step_sequence),
    prompt: String(row.prompt),
    purpose: String(row.purpose),
    status: String(row.status) as InquiryStep["status"],
    response: row.response === null ? undefined : String(row.response),
    responseKind: row.response_kind === null ? undefined : String(row.response_kind) as InquiryResponseKind,
    evidencePassageIds: JSON.parse(String(row.evidence_passage_ids_json)) as string[],
    nextMove: row.next_move === null ? undefined : String(row.next_move) as InquiryStep["nextMove"],
    createdAt: String(row.created_at),
    answeredAt: row.answered_at === null ? undefined : String(row.answered_at),
    updatedAt: row.updated_at === null ? undefined : String(row.updated_at),
  };
}

function normalizeEvidenceAnchor(row: Record<string, unknown>): EvidenceAnchor {
  const block = normalizeBlock(row);
  return {
    id: `anchor-${block.id}`,
    documentHash: String(row.document_hash),
    page: block.pageNumber,
    blockId: block.id,
    characterRange: { start: 0, end: block.sourceText.length },
    extractionRevision: block.extractionRevision,
    contentHash: block.contentHash,
    pageImageHash: row.render_hash ? String(row.render_hash) : undefined,
    boundingBox: block.boundingBox,
  };
}

export class PdfWorkspace {
  readonly rootPath: string;
  readonly databasePath: string;
  readonly assetsPath: string;
  readonly rendersPath: string;
  private readonly database: DatabaseSync;

  private constructor(rootPath: string, database: DatabaseSync) {
    this.rootPath = rootPath;
    this.databasePath = join(rootPath, "workspace.sqlite");
    this.assetsPath = join(rootPath, "assets");
    this.rendersPath = join(rootPath, "renders");
    this.database = database;
  }

  static async open(rootPath: string): Promise<PdfWorkspace> {
    const absoluteRoot = resolve(rootPath);
    await Promise.all([
      mkdir(join(absoluteRoot, "assets"), { recursive: true }),
      mkdir(join(absoluteRoot, "renders"), { recursive: true }),
    ]);
    const database = new DatabaseSync(join(absoluteRoot, "workspace.sqlite"));
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA application_id = 1397969747;");
    const workspace = new PdfWorkspace(absoluteRoot, database);
    workspace.migrate();
    workspace.ensureCorpusMaterialized();
    return workspace;
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > 7) throw new Error(`Workspace schema ${version} is newer than this app supports`);
    if (version === 0) {
      this.database.exec(`
        BEGIN;
        CREATE TABLE documents (
          id TEXT PRIMARY KEY,
          document_hash TEXT NOT NULL UNIQUE,
          original_name TEXT NOT NULL,
          asset_path TEXT NOT NULL,
          page_count INTEGER NOT NULL,
          extraction_revision INTEGER NOT NULL,
          corpus_revision INTEGER NOT NULL DEFAULT 1,
          imported_at TEXT NOT NULL
        );
        CREATE TABLE pages (
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          page_number INTEGER NOT NULL,
          width REAL NOT NULL,
          height REAL NOT NULL,
          confidence REAL NOT NULL,
          quality TEXT NOT NULL CHECK (quality IN ('good', 'review-needed', 'ocr-required')),
          render_hash TEXT,
          PRIMARY KEY (document_id, page_number)
        );
        CREATE TABLE blocks (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          page_number INTEGER NOT NULL,
          source_text TEXT NOT NULL,
          current_text TEXT NOT NULL,
          original_order INTEGER NOT NULL,
          current_order INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('included', 'excluded', 'rejected')),
          confidence REAL NOT NULL,
          x REAL NOT NULL,
          y REAL NOT NULL,
          width REAL NOT NULL,
          height REAL NOT NULL,
          content_hash TEXT NOT NULL,
          extraction_revision INTEGER NOT NULL
        );
        CREATE INDEX blocks_document_page_order ON blocks(document_id, page_number, current_order);
        CREATE TABLE block_edits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
          previous_text TEXT NOT NULL,
          next_text TEXT NOT NULL,
          previous_order INTEGER NOT NULL,
          next_order INTEGER NOT NULL,
          previous_status TEXT NOT NULL,
          next_status TEXT NOT NULL,
          note TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE sections (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          parent_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('chapter', 'section')),
          level INTEGER NOT NULL,
          start_page INTEGER NOT NULL,
          end_page INTEGER NOT NULL,
          start_block_id TEXT,
          end_block_id TEXT,
          section_order INTEGER NOT NULL,
          confidence REAL NOT NULL,
          origin TEXT NOT NULL CHECK (origin IN ('detected', 'user')),
          status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'excluded')),
          structure_revision INTEGER NOT NULL,
          rationale TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX sections_document_order ON sections(document_id, section_order);
        CREATE TABLE passages (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
          passage_sequence INTEGER NOT NULL,
          source_text TEXT NOT NULL,
          reading_text TEXT NOT NULL,
          start_page INTEGER NOT NULL,
          end_page INTEGER NOT NULL,
          start_block_id TEXT NOT NULL REFERENCES blocks(id),
          end_block_id TEXT NOT NULL REFERENCES blocks(id),
          character_count INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          extraction_revision INTEGER NOT NULL,
          structure_revision INTEGER NOT NULL,
          quality TEXT NOT NULL CHECK (quality IN ('good', 'review-needed', 'ocr-required')),
          status TEXT NOT NULL CHECK (status IN ('current', 'stale')),
          evidence_json TEXT NOT NULL,
          UNIQUE(section_id, structure_revision, passage_sequence)
        );
        CREATE INDEX passages_document_section ON passages(document_id, section_id, passage_sequence);
        CREATE VIRTUAL TABLE passage_search USING fts5(
          passage_id UNINDEXED,
          document_id UNINDEXED,
          section_id UNINDEXED,
          source_text,
          tokenize = 'porter unicode61 remove_diacritics 2'
        );
        CREATE TABLE reading_progress (
          document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
          page_number INTEGER NOT NULL,
          block_id TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE annotations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('note', 'highlight')),
          authorship TEXT NOT NULL CHECK (authorship IN ('user', 'source', 'model')) DEFAULT 'user',
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE inquiry_sessions (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          document_hash TEXT NOT NULL,
          corpus_revision INTEGER NOT NULL,
          route_json TEXT NOT NULL,
          objective TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
          evidence_json TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          request_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX inquiry_sessions_document_updated ON inquiry_sessions(document_id, updated_at DESC);
        CREATE TABLE inquiry_steps (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES inquiry_sessions(id) ON DELETE CASCADE,
          step_sequence INTEGER NOT NULL,
          prompt TEXT NOT NULL,
          purpose TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'answered')),
          response TEXT,
          response_kind TEXT CHECK (response_kind IN ('grounded-interpretation', 'personal-reflection')),
          evidence_passage_ids_json TEXT NOT NULL DEFAULT '[]',
          next_move TEXT,
          created_at TEXT NOT NULL,
          answered_at TEXT,
          updated_at TEXT,
          UNIQUE(session_id, step_sequence)
        );
        PRAGMA user_version = 7;
        COMMIT;
      `);
    }
    if (version === 1) {
      this.database.exec("ALTER TABLE pages ADD COLUMN render_hash TEXT; PRAGMA user_version = 2;");
    }
    if (version > 0 && version < 3) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS sections (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          start_page INTEGER NOT NULL,
          end_page INTEGER NOT NULL,
          section_order INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reading_progress (
          document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
          page_number INTEGER NOT NULL,
          block_id TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS annotations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('note', 'highlight')),
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        PRAGMA user_version = 3;
      `);
    }
    if (version > 0 && version < 4) {
      this.database.exec("ALTER TABLE annotations ADD COLUMN authorship TEXT NOT NULL DEFAULT 'user' CHECK (authorship IN ('user', 'source', 'model')); PRAGMA user_version = 4;");
    }
    if (version > 0 && version < 5) {
      this.database.exec(`
        BEGIN;
        ALTER TABLE documents ADD COLUMN corpus_revision INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE sections RENAME TO sections_v4;
        CREATE TABLE sections (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          parent_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('chapter', 'section')),
          level INTEGER NOT NULL,
          start_page INTEGER NOT NULL,
          end_page INTEGER NOT NULL,
          start_block_id TEXT,
          end_block_id TEXT,
          section_order INTEGER NOT NULL,
          confidence REAL NOT NULL,
          origin TEXT NOT NULL CHECK (origin IN ('detected', 'user')),
          status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'excluded')),
          structure_revision INTEGER NOT NULL,
          rationale TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO sections
          (id, document_id, parent_id, title, kind, level, start_page, end_page, start_block_id, end_block_id,
           section_order, confidence, origin, status, structure_revision, rationale, updated_at)
        SELECT id, document_id, NULL, title, 'section', 1, start_page, end_page, NULL, NULL,
          section_order, 0.25, 'detected', 'proposed', 1, 'Migrated page guide from workspace schema 4.', ''
        FROM sections_v4;
        DROP TABLE sections_v4;
        CREATE INDEX IF NOT EXISTS sections_document_order ON sections(document_id, section_order);
        CREATE TABLE passages (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
          passage_sequence INTEGER NOT NULL,
          source_text TEXT NOT NULL,
          reading_text TEXT NOT NULL,
          start_page INTEGER NOT NULL,
          end_page INTEGER NOT NULL,
          start_block_id TEXT NOT NULL REFERENCES blocks(id),
          end_block_id TEXT NOT NULL REFERENCES blocks(id),
          character_count INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          extraction_revision INTEGER NOT NULL,
          structure_revision INTEGER NOT NULL,
          quality TEXT NOT NULL CHECK (quality IN ('good', 'review-needed', 'ocr-required')),
          status TEXT NOT NULL CHECK (status IN ('current', 'stale')),
          evidence_json TEXT NOT NULL,
          UNIQUE(section_id, structure_revision, passage_sequence)
        );
        CREATE INDEX passages_document_section ON passages(document_id, section_id, passage_sequence);
        PRAGMA user_version = 5;
        COMMIT;
      `);
    }
    if (version > 0 && version < 6) {
      this.database.exec(`
        BEGIN;
        CREATE VIRTUAL TABLE passage_search USING fts5(
          passage_id UNINDEXED,
          document_id UNINDEXED,
          section_id UNINDEXED,
          source_text,
          tokenize = 'porter unicode61 remove_diacritics 2'
        );
        INSERT INTO passage_search (passage_id, document_id, section_id, source_text)
        SELECT id, document_id, section_id, source_text FROM passages WHERE status = 'current';
        PRAGMA user_version = 6;
        COMMIT;
      `);
    }
    if (version > 0 && version < 7) {
      this.database.exec(`
        BEGIN;
        CREATE TABLE inquiry_sessions (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          document_hash TEXT NOT NULL,
          corpus_revision INTEGER NOT NULL,
          route_json TEXT NOT NULL,
          objective TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
          evidence_json TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          request_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX inquiry_sessions_document_updated ON inquiry_sessions(document_id, updated_at DESC);
        CREATE TABLE inquiry_steps (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES inquiry_sessions(id) ON DELETE CASCADE,
          step_sequence INTEGER NOT NULL,
          prompt TEXT NOT NULL,
          purpose TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'answered')),
          response TEXT,
          response_kind TEXT CHECK (response_kind IN ('grounded-interpretation', 'personal-reflection')),
          evidence_passage_ids_json TEXT NOT NULL DEFAULT '[]',
          next_move TEXT,
          created_at TEXT NOT NULL,
          answered_at TEXT,
          updated_at TEXT,
          UNIQUE(session_id, step_sequence)
        );
        PRAGMA user_version = 7;
        COMMIT;
      `);
    }
  }

  private corpusBlocks(documentId: string) {
    return this.listBlocks(documentId).map((block) => ({
      id: block.id,
      pageNumber: block.pageNumber,
      sourceText: block.sourceText,
      currentText: block.currentText,
      currentOrder: block.currentOrder,
      status: block.status,
      confidence: block.confidence,
      height: block.boundingBox.height,
      extractionRevision: block.extractionRevision,
    }));
  }

  private replaceDetectedSections(documentId: string, documentName: string, pageCount: number, revision: number): void {
    const proposals = proposeCorpusSections(documentId, documentName, pageCount, this.corpusBlocks(documentId));
    this.database.prepare("DELETE FROM sections WHERE document_id = ?").run(documentId);
    const inserted: Array<{ proposal: ProposedSection; id: string }> = [];
    const updatedAt = new Date().toISOString();
    for (const [order, proposal] of proposals.entries()) {
      const identity = sha256(JSON.stringify({
        documentId,
        startBlockId: proposal.startBlockId ?? `page:${proposal.startPage}`,
        kind: proposal.kind,
        title: proposal.title,
      }));
      const id = `${documentId}-${proposal.kind}-${identity.slice("sha256:".length, "sha256:".length + 16)}`;
      const parent = proposal.kind === "section"
        ? inserted.findLast(({ proposal: candidate }) => candidate.kind === "chapter")?.id
        : undefined;
      this.database
        .prepare(
          `INSERT INTO sections
           (id, document_id, parent_id, title, kind, level, start_page, end_page, start_block_id,
            end_block_id, section_order, confidence, origin, status, structure_revision, rationale, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'detected', 'proposed', ?, ?, ?)`,
        )
        .run(
          id,
          documentId,
          parent ?? null,
          proposal.title,
          proposal.kind,
          proposal.level,
          proposal.startPage,
          proposal.endPage,
          proposal.startBlockId ?? null,
          proposal.endBlockId ?? null,
          order,
          proposal.confidence,
          revision,
          proposal.rationale,
          updatedAt,
        );
      inserted.push({ proposal, id });
    }
  }

  private regeneratePassages(documentId: string, sectionIds?: string[]): void {
    const selected = sectionIds ? new Set(sectionIds) : undefined;
    const sections = this.listSections(documentId).filter((section) => !selected || selected.has(section.id));
    for (const section of sections) {
      this.database.prepare("DELETE FROM passage_search WHERE document_id = ? AND section_id = ?").run(documentId, section.id);
      this.database
        .prepare("UPDATE passages SET status = 'stale' WHERE document_id = ? AND section_id = ? AND status = 'current'")
        .run(documentId, section.id);
    }
    const pages = new Map(this.listPages(documentId).map((page) => [page.pageNumber, page]));
    const blocks = this.corpusBlocks(documentId);
    const passageBlockIndex = indexPassageBlocks(blocks);
    const evidence = new Map(
      this.database
        .prepare(
          `SELECT b.*, d.document_hash, p.render_hash
           FROM blocks b
           JOIN documents d ON d.id = b.document_id
           JOIN pages p ON p.document_id = b.document_id AND p.page_number = b.page_number
           WHERE b.document_id = ?`,
        )
        .all(documentId)
        .map((row) => {
          const anchor = normalizeEvidenceAnchor(row);
          return [anchor.blockId, anchor] as const;
        }),
    );
    for (const section of sections.filter(({ status }) => status !== "excluded")) {
      const drafts = buildPassageDrafts(
        documentId,
        section,
        blocks,
        (pageNumber) => pages.get(pageNumber)?.quality ?? "review-needed",
        (blockId) => {
          const anchor = evidence.get(blockId);
          if (!anchor) throw new Error(`Unknown block: ${blockId}`);
          return anchor;
        },
        1_200,
        passageBlockIndex,
      );
      for (const passage of drafts) {
        this.database
          .prepare(
            `INSERT INTO passages
             (id, document_id, section_id, passage_sequence, source_text, reading_text, start_page, end_page,
              start_block_id, end_block_id, character_count, content_hash, extraction_revision,
              structure_revision, quality, status, evidence_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?)
             ON CONFLICT(id) DO UPDATE SET status = 'current', reading_text = excluded.reading_text,
               structure_revision = excluded.structure_revision, quality = excluded.quality, evidence_json = excluded.evidence_json`,
          )
          .run(
            passage.id,
            documentId,
            passage.sectionId,
            passage.sequence,
            passage.sourceText,
            passage.readingText,
            passage.startPage,
            passage.endPage,
            passage.startBlockId,
            passage.endBlockId,
            passage.characterCount,
            passage.contentHash,
            passage.extractionRevision,
            passage.structureRevision,
            passage.quality,
            JSON.stringify(passage.evidence),
          );
        this.database
          .prepare("INSERT INTO passage_search (passage_id, document_id, section_id, source_text) VALUES (?, ?, ?, ?)")
          .run(passage.id, documentId, section.id, passage.sourceText);
      }
    }
  }

  private isUntouchedLegacyPageGuide(documentId: string, sections: DocumentSection[], pageCount: number): boolean {
    return sections.length === pageCount && sections.every((section, index) =>
      section.title === `Page ${index + 1}` &&
      section.startPage === index + 1 &&
      section.endPage === index + 1 &&
      section.rationale === "Migrated page guide from workspace schema 4.",
    );
  }

  private ensureCorpusMaterialized(): void {
    const rows = this.database.prepare("SELECT id, original_name, page_count, corpus_revision FROM documents").all();
    for (const row of rows) {
      const documentId = String(row.id);
      const revision = Number(row.corpus_revision);
      const sections = this.listSections(documentId);
      const passageCount = Number(
        this.database.prepare("SELECT COUNT(*) AS count FROM passages WHERE document_id = ? AND status = 'current'").get(documentId)?.count ?? 0,
      );
      if (!this.isUntouchedLegacyPageGuide(documentId, sections, Number(row.page_count)) && passageCount > 0) continue;
      this.database.exec("BEGIN");
      try {
        if (this.isUntouchedLegacyPageGuide(documentId, sections, Number(row.page_count))) {
          this.replaceDetectedSections(documentId, String(row.original_name), Number(row.page_count), revision);
        }
        this.regeneratePassages(documentId);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private nextCorpusRevision(documentId: string): number {
    const document = this.getDocument(documentId);
    if (!document) throw new Error(`Unknown document: ${documentId}`);
    const revision = document.corpusRevision + 1;
    this.database.prepare("UPDATE documents SET corpus_revision = ? WHERE id = ?").run(revision, documentId);
    return revision;
  }

  private requireCorpusRevision(documentId: string, expectedRevision: number): ImportedDocument {
    const document = this.getDocument(documentId);
    if (!document) throw new Error(`Unknown document: ${documentId}`);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error("A positive expectedCorpusRevision is required");
    }
    if (document.corpusRevision !== expectedRevision) {
      throw new CorpusRevisionConflictError(documentId, expectedRevision, document.corpusRevision);
    }
    return document;
  }

  private refreshCorpusAfterBlockEdit(documentId: string, pageNumber: number): number {
    const revision = this.nextCorpusRevision(documentId);
    const affected = this.listSections(documentId).filter(({ startPage, endPage }) => pageNumber >= startPage && pageNumber <= endPage);
    if (affected.length === 0) return revision;
    this.database
      .prepare(`UPDATE sections SET structure_revision = ?, updated_at = ? WHERE id IN (${affected.map(() => "?").join(",")})`)
      .run(revision, new Date().toISOString(), ...affected.map(({ id }) => id));
    this.regeneratePassages(documentId, affected.map(({ id }) => id));
    return revision;
  }

  async importPdf(filePath: string): Promise<ImportedDocument> {
    const bytes = new Uint8Array(await readFile(filePath));
    const documentHash = fileHash(bytes);
    const existing = this.getDocumentByHash(documentHash);
    if (existing) {
      await this.verifyDocumentAsset(existing.id);
      return existing;
    }

    const id = documentId(documentHash);
    const assetPath = join(this.assetsPath, `${documentHash.slice(7)}.pdf`);
    const loadingTask = getDocument({ data: bytes, useSystemFonts: true, disableFontFace: true });
    const pdf = await loadingTask.promise;
    const pageCount = pdf.numPages;
    await copyFile(filePath, assetPath);
    const importedAt = new Date().toISOString();
    const revision = 1;

    this.database.exec("BEGIN");
    try {
      this.database
        .prepare(
          `INSERT INTO documents
           (id, document_hash, original_name, asset_path, page_count, extraction_revision, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, documentHash, basename(filePath), assetPath, pdf.numPages, revision, importedAt);

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent();
        const rawBlocks: RawBlock[] = textContent.items.flatMap((item, order) => {
          if (!("str" in item) || item.str.trim().length === 0) return [];
          const [, , , scaleY, translateX, translateY] = item.transform;
          return [
            {
              text: item.str,
              order,
              x: Math.max(0, translateX / viewport.width),
              y: Math.max(0, 1 - translateY / viewport.height),
              width: Math.max(0, item.width / viewport.width),
              height: Math.max(0, Math.abs(item.height || scaleY) / viewport.height),
            },
          ];
        });
        const quality = pageQuality(rawBlocks);
        const orderedBlocks = deterministicReadingOrder(rawBlocks);
        this.database
          .prepare(
            `INSERT INTO pages
             (document_id, page_number, width, height, confidence, quality)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, pageNumber, viewport.width, viewport.height, quality.confidence, quality.quality);

        for (const [currentOrder, block] of orderedBlocks.entries()) {
          const blockId = `${id}-p${pageNumber}-b${block.order}`;
          this.database
            .prepare(
              `INSERT INTO blocks
               (id, document_id, page_number, source_text, current_text, original_order, current_order,
                status, confidence, x, y, width, height, content_hash, extraction_revision)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'included', ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              blockId,
              id,
              pageNumber,
              block.text,
              block.text,
              block.order,
              currentOrder,
              quality.confidence,
              block.x,
              block.y,
              block.width,
              block.height,
              sha256(block.text),
              revision,
            );
        }
      }
      this.replaceDetectedSections(id, basename(filePath), pageCount, revision);
      this.regeneratePassages(id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      await unlink(assetPath).catch(() => undefined);
      throw error;
    } finally {
      await loadingTask.destroy();
    }

    return {
      id,
      documentHash,
      originalName: basename(filePath),
      assetPath,
      pageCount,
      extractionRevision: revision,
      corpusRevision: revision,
    };
  }

  getDocument(id: string): ImportedDocument | undefined {
    const row = this.database.prepare("SELECT * FROM documents WHERE id = ?").get(id);
    return row ? this.normalizeDocument(row) : undefined;
  }

  getDocumentByHash(hash: string): ImportedDocument | undefined {
    const row = this.database.prepare("SELECT * FROM documents WHERE document_hash = ?").get(hash);
    return row ? this.normalizeDocument(row) : undefined;
  }

  private normalizeDocument(row: Record<string, unknown>): ImportedDocument {
    return {
      id: String(row.id),
      documentHash: String(row.document_hash),
      originalName: String(row.original_name),
      assetPath: String(row.asset_path),
      pageCount: Number(row.page_count),
      extractionRevision: Number(row.extraction_revision),
      corpusRevision: Number(row.corpus_revision),
    };
  }

  async verifyDocumentAsset(id: string): Promise<void> {
    const document = this.getDocument(id);
    if (!document) throw new Error(`Unknown document: ${id}`);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(document.assetPath));
    } catch {
      throw new WorkspaceIntegrityError(`Stored source asset is missing for ${id}`);
    }
    if (fileHash(bytes) !== document.documentHash) {
      throw new WorkspaceIntegrityError(`Stored source asset hash does not match ${id}`);
    }
  }

  listPages(documentId: string): ExtractedPage[] {
    return this.database
      .prepare("SELECT * FROM pages WHERE document_id = ? ORDER BY page_number")
      .all(documentId)
      .map((row) => ({
        documentId: String(row.document_id),
        pageNumber: Number(row.page_number),
        width: Number(row.width),
        height: Number(row.height),
        confidence: Number(row.confidence),
        quality: String(row.quality) as PageQuality,
        renderHash: row.render_hash ? String(row.render_hash) : undefined,
      }));
  }

  async inspectPage(documentId: string, pageNumber: number, scale = 1.5): Promise<PageInspection> {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new Error("Page number must be positive");
    if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error("Render scale must be between 0 and 4");
    await this.verifyDocumentAsset(documentId);
    const document = this.getDocument(documentId)!;
    if (pageNumber > document.pageCount) throw new Error(`Page ${pageNumber} is outside the document`);
    const bytes = new Uint8Array(await readFile(document.assetPath));
    const loadingTask = getDocument({ data: bytes, useSystemFonts: true, disableFontFace: true });
    try {
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
      const png = canvas.toBuffer("image/png");
      const renderHash = sha256(png);
      const renderPath = join(this.rendersPath, `${document.id}-p${pageNumber}-s${scale}.png`);
      await writeFile(renderPath, png);
      this.database
        .prepare("UPDATE pages SET render_hash = ? WHERE document_id = ? AND page_number = ?")
        .run(renderHash, documentId, pageNumber);
      const pageRecord = this.listPages(documentId).find((candidate) => candidate.pageNumber === pageNumber)!;
      return {
        page: pageRecord,
        blocks: this.listBlocks(documentId, pageNumber),
        renderPath,
        renderHash,
      };
    } finally {
      await loadingTask.destroy();
    }
  }

  listBlocks(documentId: string, pageNumber?: number): ExtractedBlock[] {
    const rows = pageNumber
      ? this.database
          .prepare("SELECT * FROM blocks WHERE document_id = ? AND page_number = ? ORDER BY current_order")
          .all(documentId, pageNumber)
      : this.database
          .prepare("SELECT * FROM blocks WHERE document_id = ? ORDER BY page_number, current_order")
          .all(documentId);
    return rows.map(normalizeBlock);
  }

  listIncludedBlocksInPageRange(documentId: string, startPage: number, endPage: number): ExtractedBlock[] {
    return this.database
      .prepare(
        `SELECT * FROM blocks
         WHERE document_id = ? AND page_number BETWEEN ? AND ? AND status = 'included'
         ORDER BY page_number, current_order`,
      )
      .all(documentId, startPage, endPage)
      .map(normalizeBlock);
  }

  listIncludedBlocksForSection(sectionId: string): ExtractedBlock[] {
    const section = this.getSection(sectionId);
    if (!section) throw new Error(`Unknown section: ${sectionId}`);
    const blocks = this.listIncludedBlocksInPageRange(section.documentId, section.startPage, section.endPage);
    const startIndex = section.startBlockId ? blocks.findIndex(({ id }) => id === section.startBlockId) : 0;
    const explicitEndIndex = section.endBlockId ? blocks.findIndex(({ id }) => id === section.endBlockId) : -1;
    const endIndex = explicitEndIndex >= 0 ? explicitEndIndex : blocks.length - 1;
    return startIndex >= 0 && endIndex >= startIndex ? blocks.slice(startIndex, endIndex + 1) : blocks;
  }

  editBlock(
    blockId: string,
    patch: { text?: string; order?: number; status?: BlockStatus },
    note: string,
    expectedCorpusRevision: number,
  ): ExtractedBlock {
    const currentRow = this.database.prepare("SELECT * FROM blocks WHERE id = ?").get(blockId);
    if (!currentRow) throw new Error(`Unknown block: ${blockId}`);
    const current = normalizeBlock(currentRow);
    const nextText = patch.text ?? current.currentText;
    const nextOrder = patch.order ?? current.currentOrder;
    const nextStatus = patch.status ?? current.status;
    if (!Number.isSafeInteger(nextOrder) || nextOrder < 0) throw new Error("Block order must be a non-negative integer");
    if (!(["included", "excluded", "rejected"] as string[]).includes(nextStatus)) {
      throw new Error("Invalid block status");
    }

    this.database.exec("BEGIN");
    try {
      this.requireCorpusRevision(current.documentId, expectedCorpusRevision);
      this.database
        .prepare(
          `INSERT INTO block_edits
           (block_id, previous_text, next_text, previous_order, next_order, previous_status, next_status, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          blockId,
          current.currentText,
          nextText,
          current.currentOrder,
          nextOrder,
          current.status,
          nextStatus,
          note,
          new Date().toISOString(),
        );
      this.database
        .prepare("UPDATE blocks SET current_text = ?, current_order = ?, status = ? WHERE id = ?")
        .run(nextText, nextOrder, nextStatus, blockId);
      this.refreshCorpusAfterBlockEdit(current.documentId, current.pageNumber);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return normalizeBlock(this.database.prepare("SELECT * FROM blocks WHERE id = ?").get(blockId)!);
  }

  reorderBlock(blockId: string, direction: -1 | 1, expectedCorpusRevision: number): ExtractedBlock[] {
    const currentRow = this.database.prepare("SELECT * FROM blocks WHERE id = ?").get(blockId);
    if (!currentRow) throw new Error(`Unknown block: ${blockId}`);
    const current = normalizeBlock(currentRow);
    const siblings = this.listBlocks(current.documentId, current.pageNumber);
    const index = siblings.findIndex(({ id }) => id === blockId);
    const targetIndex = index + direction;
    this.requireCorpusRevision(current.documentId, expectedCorpusRevision);
    if (targetIndex < 0 || targetIndex >= siblings.length) return siblings;
    const target = siblings[targetIndex]!;
    const createdAt = new Date().toISOString();

    this.database.exec("BEGIN");
    try {
      this.requireCorpusRevision(current.documentId, expectedCorpusRevision);
      for (const [block, nextOrder] of [
        [current, target.currentOrder],
        [target, current.currentOrder],
      ] as const) {
        this.database
          .prepare(
            `INSERT INTO block_edits
             (block_id, previous_text, next_text, previous_order, next_order, previous_status, next_status, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            block.id,
            block.currentText,
            block.currentText,
            block.currentOrder,
            nextOrder,
            block.status,
            block.status,
            direction < 0 ? "Reader move earlier" : "Reader move later",
            createdAt,
          );
        this.database.prepare("UPDATE blocks SET current_order = ? WHERE id = ?").run(nextOrder, block.id);
      }
      this.refreshCorpusAfterBlockEdit(current.documentId, current.pageNumber);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.listBlocks(current.documentId, current.pageNumber);
  }

  listBlockEdits(blockId: string): BlockEdit[] {
    return this.database
      .prepare("SELECT * FROM block_edits WHERE block_id = ? ORDER BY id")
      .all(blockId)
      .map((row) => ({
        id: Number(row.id),
        blockId: String(row.block_id),
        previousText: String(row.previous_text),
        nextText: String(row.next_text),
        previousOrder: Number(row.previous_order),
        nextOrder: Number(row.next_order),
        previousStatus: String(row.previous_status) as BlockStatus,
        nextStatus: String(row.next_status) as BlockStatus,
        note: String(row.note),
        createdAt: String(row.created_at),
      }));
  }

  evidenceForBlock(blockId: string): EvidenceAnchor {
    const row = this.database
      .prepare(
        `SELECT b.*, d.document_hash, p.render_hash
         FROM blocks b
         JOIN documents d ON d.id = b.document_id
         JOIN pages p ON p.document_id = b.document_id AND p.page_number = b.page_number
         WHERE b.id = ?`,
      )
      .get(blockId);
    if (!row) throw new Error(`Unknown block: ${blockId}`);
    return normalizeEvidenceAnchor(row);
  }

  listSections(documentId: string): DocumentSection[] {
    return this.database
      .prepare("SELECT * FROM sections WHERE document_id = ? ORDER BY section_order")
      .all(documentId)
      .map(normalizeSection);
  }

  getSection(sectionId: string): DocumentSection | undefined {
    const row = this.database.prepare("SELECT document_id FROM sections WHERE id = ?").get(sectionId);
    return row ? this.listSections(String(row.document_id)).find(({ id }) => id === sectionId) : undefined;
  }

  updateSection(
    sectionId: string,
    patch: Partial<Omit<Pick<DocumentSection, "title" | "kind" | "level" | "startPage" | "endPage" | "order" | "status" | "parentId">, "parentId">> & { parentId?: string | null },
    expectedCorpusRevision: number,
  ): DocumentSection {
    const row = this.database.prepare("SELECT * FROM sections WHERE id = ?").get(sectionId);
    if (!row) throw new Error(`Unknown section: ${sectionId}`);
    const current = normalizeSection(row);
    const next: DocumentSection = {
      ...current,
      title: patch.title ?? current.title,
      kind: patch.kind ?? current.kind,
      level: patch.level ?? current.level,
      startPage: patch.startPage ?? current.startPage,
      endPage: patch.endPage ?? current.endPage,
      order: patch.order ?? current.order,
      status: patch.status ?? current.status,
      parentId: patch.parentId === null ? undefined : patch.parentId ?? current.parentId,
    };
    const document = this.getDocument(next.documentId)!;
    if (!next.title.trim()) throw new Error("Section title is required");
    if (next.kind !== "chapter" && next.kind !== "section") throw new Error("Section kind must be chapter or section");
    if (!Number.isSafeInteger(next.level) || next.level < 1 || next.level > 6) throw new Error("Section level must be from 1 to 6");
    if (!(new Set<CorpusSectionStatus>(["proposed", "accepted", "excluded"])).has(next.status)) throw new Error("Invalid section status");
    if (!Number.isSafeInteger(next.order) || next.order < 0) throw new Error("Section order must be a non-negative integer");
    if (
      !Number.isSafeInteger(next.startPage) ||
      !Number.isSafeInteger(next.endPage) ||
      next.startPage < 1 ||
      next.endPage < next.startPage ||
      next.endPage > document.pageCount
    ) {
      throw new Error("Section page range is outside the document");
    }
    if (next.parentId) {
      const parent = this.getSection(next.parentId);
      if (!parent || parent.documentId !== next.documentId || parent.id === next.id) throw new Error("Section parent is invalid");
      const visited = new Set([next.id]);
      let ancestor: DocumentSection | undefined = parent;
      while (ancestor) {
        if (visited.has(ancestor.id)) throw new Error("Section parent would create a hierarchy cycle");
        visited.add(ancestor.id);
        ancestor = ancestor.parentId ? this.getSection(ancestor.parentId) : undefined;
      }
    }
    const startPageChanged = next.startPage !== current.startPage;
    const endPageChanged = next.endPage !== current.endPage;
    const pageRangeChanged = startPageChanged || endPageChanged;
    const nextStartBlockId = startPageChanged
      ? this.listIncludedBlocksInPageRange(next.documentId, next.startPage, next.startPage)[0]?.id
      : current.startBlockId;
    const nextEndBlockId = endPageChanged
      ? this.listIncludedBlocksInPageRange(next.documentId, next.endPage, next.endPage).at(-1)?.id
      : current.endBlockId;
    this.database.exec("BEGIN");
    try {
      this.requireCorpusRevision(next.documentId, expectedCorpusRevision);
      const revision = this.nextCorpusRevision(next.documentId);
      const updatedAt = new Date().toISOString();
      this.database
        .prepare(
          `UPDATE sections SET parent_id = ?, title = ?, kind = ?, level = ?, start_page = ?, end_page = ?,
           start_block_id = ?, end_block_id = ?, section_order = ?, confidence = 1, origin = 'user', status = ?, structure_revision = ?,
           rationale = 'Edited by the user.', updated_at = ? WHERE id = ?`,
        )
        .run(
          next.parentId ?? null,
          next.title.trim(),
          next.kind,
          next.level,
          next.startPage,
          next.endPage,
          nextStartBlockId ?? null,
          nextEndBlockId ?? null,
          next.order,
          next.status,
          revision,
          updatedAt,
          sectionId,
        );
      const passageScopeChanged = pageRangeChanged || next.status !== current.status;
      if (passageScopeChanged) this.regeneratePassages(next.documentId, [sectionId]);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getSection(sectionId)!;
  }

  splitSection(sectionId: string, atPage: number, title: string | undefined, expectedCorpusRevision: number): DocumentSection[] {
    const current = this.getSection(sectionId);
    if (!current) throw new Error(`Unknown section: ${sectionId}`);
    if (!Number.isSafeInteger(atPage) || atPage <= current.startPage || atPage > current.endPage) {
      throw new Error("Split page must fall after the first page and inside the section");
    }
    const revision = this.getDocument(current.documentId)!.corpusRevision + 1;
    const nextIdHash = sha256(JSON.stringify({ documentId: current.documentId, sectionId, atPage, revision }));
    const nextId = `${current.documentId}-section-${nextIdHash.slice("sha256:".length, "sha256:".length + 16)}`;
    const updatedAt = new Date().toISOString();
    const splitBlocks = this.listIncludedBlocksInPageRange(current.documentId, atPage, current.endPage);
    const firstSplitBlock = splitBlocks[0];
    const priorBlocks = this.listIncludedBlocksInPageRange(current.documentId, current.startPage, atPage - 1);
    const lastPriorBlock = priorBlocks.at(-1);
    this.database.exec("BEGIN");
    try {
      this.requireCorpusRevision(current.documentId, expectedCorpusRevision);
      this.nextCorpusRevision(current.documentId);
      this.database
        .prepare(
          `UPDATE sections SET end_page = ?, end_block_id = ?, confidence = 1, origin = 'user',
           status = 'accepted', structure_revision = ?, rationale = 'Split by the user.', updated_at = ? WHERE id = ?`,
        )
        .run(atPage - 1, lastPriorBlock?.id ?? null, revision, updatedAt, current.id);
      this.database
        .prepare("UPDATE sections SET section_order = section_order + 1, structure_revision = ? WHERE document_id = ? AND section_order > ?")
        .run(revision, current.documentId, current.order);
      this.database
        .prepare(
          `INSERT INTO sections
           (id, document_id, parent_id, title, kind, level, start_page, end_page, start_block_id, end_block_id,
            section_order, confidence, origin, status, structure_revision, rationale, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'user', 'accepted', ?, 'Split by the user.', ?)`,
        )
        .run(
          nextId,
          current.documentId,
          current.parentId ?? null,
          title?.trim() || `${current.title} — continued`,
          current.kind,
          current.level,
          atPage,
          current.endPage,
          firstSplitBlock?.id ?? null,
          current.endBlockId ?? splitBlocks.at(-1)?.id ?? null,
          current.order + 1,
          revision,
          updatedAt,
        );
      this.regeneratePassages(current.documentId, [current.id, nextId]);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.listSections(current.documentId);
  }

  mergeSections(sectionId: string, targetSectionId: string, expectedCorpusRevision: number): DocumentSection[] {
    const current = this.getSection(sectionId);
    const target = this.getSection(targetSectionId);
    if (!current || !target) throw new Error("Both sections are required for a merge");
    if (current.documentId !== target.documentId || current.id === target.id) throw new Error("Sections must be distinct and in the same document");
    const ordered = [current, target].sort((left, right) => left.startPage - right.startPage || left.order - right.order);
    const [first, second] = ordered;
    if (second!.startPage > first!.endPage + 1) throw new Error("Only adjacent or overlapping sections can be merged");
    const revision = this.getDocument(current.documentId)!.corpusRevision + 1;
    const updatedAt = new Date().toISOString();
    this.database.exec("BEGIN");
    try {
      this.requireCorpusRevision(current.documentId, expectedCorpusRevision);
      this.nextCorpusRevision(current.documentId);
      const retainedParentId = first!.parentId === second!.id ? second!.parentId : first!.parentId;
      this.database
        .prepare(
          `UPDATE sections SET parent_id = ?, title = ?, start_page = ?, end_page = ?, start_block_id = ?, end_block_id = ?,
           confidence = 1, origin = 'user', status = 'accepted', structure_revision = ?,
           rationale = 'Merged by the user.', updated_at = ? WHERE id = ?`,
        )
        .run(
          retainedParentId ?? null,
          first!.title,
          first!.startPage,
          Math.max(first!.endPage, second!.endPage),
          first!.startBlockId ?? second!.startBlockId ?? null,
          second!.endBlockId ?? first!.endBlockId ?? null,
          revision,
          updatedAt,
          first!.id,
        );
      this.database
        .prepare("UPDATE sections SET parent_id = ? WHERE parent_id = ? AND id <> ?")
        .run(first!.id, second!.id, first!.id);
      this.database.prepare("DELETE FROM sections WHERE id = ?").run(second!.id);
      const remaining = this.listSections(current.documentId);
      remaining.forEach((section, order) => {
        this.database
          .prepare("UPDATE sections SET section_order = ? WHERE id = ?")
          .run(order, section.id);
      });
      this.regeneratePassages(current.documentId, [first!.id]);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.listSections(current.documentId);
  }

  reorderSection(sectionId: string, direction: -1 | 1, expectedCorpusRevision: number): DocumentSection[] {
    const current = this.getSection(sectionId);
    if (!current) throw new Error(`Unknown section: ${sectionId}`);
    const sections = this.listSections(current.documentId);
    const index = sections.findIndex(({ id }) => id === sectionId);
    const target = sections[index + direction];
    this.requireCorpusRevision(current.documentId, expectedCorpusRevision);
    if (!target) return sections;
    const revision = this.getDocument(current.documentId)!.corpusRevision + 1;
    this.database.exec("BEGIN");
    try {
      this.requireCorpusRevision(current.documentId, expectedCorpusRevision);
      this.nextCorpusRevision(current.documentId);
      const updatedAt = new Date().toISOString();
      this.database
        .prepare("UPDATE sections SET section_order = ?, origin = 'user', structure_revision = ?, updated_at = ? WHERE id = ?")
        .run(target.order, revision, updatedAt, current.id);
      this.database
        .prepare("UPDATE sections SET section_order = ?, origin = 'user', structure_revision = ?, updated_at = ? WHERE id = ?")
        .run(current.order, revision, updatedAt, target.id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.listSections(current.documentId);
  }

  listPassages(documentId: string, sectionId?: string, includeStale = false): DocumentPassage[] {
    const statusClause = includeStale ? "" : "AND status = 'current'";
    const rows = sectionId
      ? this.database
          .prepare(`SELECT * FROM passages WHERE document_id = ? AND section_id = ? ${statusClause} ORDER BY passage_sequence`)
          .all(documentId, sectionId)
      : this.database
          .prepare(`SELECT * FROM passages WHERE document_id = ? ${statusClause} ORDER BY start_page, passage_sequence`)
          .all(documentId);
    return rows.map(normalizePassage);
  }

  listPassagesPage(
    documentId: string,
    options: { sectionId?: string; includeStale?: boolean; limit: number; offset: number },
  ): { items: DocumentPassage[]; nextOffset?: number } {
    const statusClause = options.includeStale ? "" : "AND status = 'current'";
    const rows = options.sectionId
      ? this.database
          .prepare(`SELECT * FROM passages WHERE document_id = ? AND section_id = ? ${statusClause} ORDER BY passage_sequence LIMIT ? OFFSET ?`)
          .all(documentId, options.sectionId, options.limit + 1, options.offset)
      : this.database
          .prepare(`SELECT * FROM passages WHERE document_id = ? ${statusClause} ORDER BY start_page, passage_sequence LIMIT ? OFFSET ?`)
          .all(documentId, options.limit + 1, options.offset);
    const hasMore = rows.length > options.limit;
    return {
      items: rows.slice(0, options.limit).map(normalizePassage),
      nextOffset: hasMore ? options.offset + options.limit : undefined,
    };
  }

  async searchQuery(input: SearchQuery): Promise<SearchResponse> {
    if (!input || typeof input !== "object") throw new Error("A search request is required");
    if (typeof input.documentId !== "string" || !input.documentId) throw new Error("A documentId is required");
    const document = this.getDocument(input.documentId);
    if (!document) throw new Error(`Unknown document: ${input.documentId}`);
    await this.verifyDocumentAsset(document.id);
    if (!input.sourceRevision || !Number.isSafeInteger(input.sourceRevision.corpusRevision) || input.sourceRevision.corpusRevision < 1) {
      throw new Error("sourceRevision.corpusRevision is required");
    }
    if (input.sourceRevision.corpusRevision !== document.corpusRevision) {
      throw new CorpusRevisionConflictError(document.id, input.sourceRevision.corpusRevision, document.corpusRevision);
    }
    if (input.sourceRevision.documentHash && input.sourceRevision.documentHash !== document.documentHash) {
      throw new SourceRevisionConflictError(document.id, "The requested document hash does not match the current source asset");
    }
    if (
      input.sourceRevision.extractionRevision !== undefined &&
      input.sourceRevision.extractionRevision !== document.extractionRevision
    ) {
      throw new SourceRevisionConflictError(document.id, "The requested extraction revision is not available in the current corpus");
    }
    if (typeof input.query !== "string" || !input.query.trim()) throw new Error("A non-empty search query is required");
    if (input.query.length > 500) throw new Error("Search query must be at most 500 characters");
    const terms = normalizedSearchTerms(input.query);
    if (terms.length === 0) throw new Error("Search query must contain a word or number");

    const limit = input.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Search limit must be an integer from 1 to 20");
    const maxCharacters = input.contextBudget?.maxCharacters ?? 6_000;
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 256 || maxCharacters > 20_000) {
      throw new Error("Context budget must be an integer from 256 to 20,000 source-text characters");
    }

    const filters = input.filters ?? {};
    const sectionIds = [...new Set(filters.sectionIds ?? [])];
    if (sectionIds.length > 50 || sectionIds.some((id) => typeof id !== "string" || !id)) {
      throw new Error("At most 50 non-empty section IDs may be filtered");
    }
    if (sectionIds.length) {
      const validSections = this.database
        .prepare(`SELECT id FROM sections WHERE document_id = ? AND id IN (${sectionIds.map(() => "?").join(",")})`)
        .all(document.id, ...sectionIds);
      if (validSections.length !== sectionIds.length) throw new Error("Every section filter must belong to the requested document");
    }
    const pageRange = filters.pageRange;
    if (
      pageRange &&
      (!Number.isSafeInteger(pageRange.start) || !Number.isSafeInteger(pageRange.end) || pageRange.start < 1 ||
        pageRange.end < pageRange.start || pageRange.end > document.pageCount)
    ) {
      throw new Error("Search page range is outside the document");
    }
    const allowedQualities = new Set<SearchQuality>(["good", "review-needed", "ocr-required"]);
    const qualities = [...new Set(filters.qualities ?? [...allowedQualities])];
    if (qualities.length === 0 || qualities.some((quality) => !allowedQualities.has(quality))) throw new Error("Search quality filter is invalid");
    const allowedReviewStates = new Set<SearchReviewState>(["proposed", "accepted"]);
    const reviewStates = [...new Set(filters.reviewStates ?? ["accepted"])] as SearchReviewState[];
    if (reviewStates.length === 0 || reviewStates.some((status) => !allowedReviewStates.has(status))) throw new Error("Search review-state filter is invalid");
    const allowedVisuals = new Set<VisualFilter>(["any", "present", "figure", "table", "unknown"]);
    const visual = filters.visual ?? "any";
    if (!allowedVisuals.has(visual)) throw new Error("Search visual filter is invalid");
    if (
      filters.extractionRevision !== undefined &&
      (!Number.isSafeInteger(filters.extractionRevision) || filters.extractionRevision < 1)
    ) throw new Error("Search extraction revision filter is invalid");

    const clauses = [
      "passage_search MATCH ?",
      "p.document_id = ?",
      "p.status = 'current'",
      `p.quality IN (${qualities.map(() => "?").join(",")})`,
      `s.status IN (${reviewStates.map(() => "?").join(",")})`,
    ];
    const parameters: Array<string | number> = [ftsSearchExpression(terms), document.id, ...qualities, ...reviewStates];
    if (sectionIds.length) {
      clauses.push(`p.section_id IN (${sectionIds.map(() => "?").join(",")})`);
      parameters.push(...sectionIds);
    }
    if (pageRange) {
      clauses.push("p.end_page >= ? AND p.start_page <= ?");
      parameters.push(pageRange.start, pageRange.end);
    }
    if (filters.extractionRevision !== undefined) {
      clauses.push("p.extraction_revision = ?");
      parameters.push(filters.extractionRevision);
    }
    const candidateLimit = Math.min(200, Math.max(limit * 20, 40));
    const rows = this.database
      .prepare(
        `SELECT p.*, s.title AS section_title, s.kind AS section_kind, s.status AS section_status,
          s.section_order, s.start_page AS section_start_page, s.end_page AS section_end_page,
          CASE WHEN lower(trim(s.title)) IN ('contents', 'table of contents', 'notes', 'endnotes', 'bibliography', 'references', 'acknowledgments', 'index') THEN 1 ELSE 0 END AS navigation_penalty,
          bm25(passage_search, 0, 0, 0, 1) AS lexical_rank
         FROM passage_search
         JOIN passages p ON p.id = passage_search.passage_id
         JOIN sections s ON s.id = p.section_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY navigation_penalty ASC, lexical_rank ASC, s.section_order ASC, p.passage_sequence ASC, p.id ASC
         LIMIT ?`,
      )
      .all(...parameters, candidateLimit);

    let usedCharacters = 0;
    let omittedResultCount = 0;
    const budgetExcludedSizes: number[] = [];
    const results: SearchResult[] = [];
    for (const row of rows) {
      const passage = normalizePassage(row);
      if (!evidenceMatchesVisualFilter(passage.evidence, visual)) continue;
      if (results.length >= limit) break;
      if (passage.sourceText.length > maxCharacters - usedCharacters) {
        omittedResultCount += 1;
        budgetExcludedSizes.push(passage.sourceText.length);
        continue;
      }
      const matchedTerms = matchedSearchTerms(passage.sourceText, terms);
      const sourceBlocks = passage.sourceText.split("\n\n");
      const preferredEvidenceIndex = sourceBlocks.reduce((bestIndex, sourceBlock, index) => {
        const score = matchedSearchTerms(sourceBlock, terms).length;
        const bestScore = matchedSearchTerms(sourceBlocks[bestIndex] ?? "", terms).length;
        return score > bestScore ? index : bestIndex;
      }, 0);
      const preferredEvidenceId = passage.evidence[preferredEvidenceIndex]?.id ?? passage.evidence[0]?.id;
      if (!preferredEvidenceId) continue;
      results.push({
        rank: results.length + 1,
        score: Number(Math.max(0, -Number(row.lexical_rank)).toFixed(8)),
        scoreExplanation: `${matchedTerms.length} of ${terms.length} normalized query terms matched immutable source text; body sections are preferred to contents, notes, and index navigation before SQLite FTS5 BM25 and stable tie-breaks are applied.`,
        labels: { passage: "source", ranking: "derived", snippet: "derived-from-source" },
        trust: "untrusted-source",
        passage: {
          id: passage.id,
          sectionId: passage.sectionId,
          sourceText: passage.sourceText,
          readingText: passage.readingText,
          pages: [passage.startPage, passage.endPage],
          quality: passage.quality,
          contentHash: passage.contentHash,
          extractionRevision: passage.extractionRevision,
          structureRevision: passage.structureRevision,
          characterCount: passage.sourceText.length,
        },
        section: {
          id: passage.sectionId,
          title: String(row.section_title),
          kind: String(row.section_kind) as SearchResult["section"]["kind"],
          status: String(row.section_status) as CorpusSectionStatus,
          order: Number(row.section_order),
          pages: [Number(row.section_start_page), Number(row.section_end_page)],
        },
        snippet: plainSearchSnippet(passage.sourceText, terms),
        matchedTerms,
        preferredEvidenceId,
        evidence: passage.evidence,
      });
      usedCharacters += passage.sourceText.length;
    }

    const outcome = results.length > 0 ? "matches" : budgetExcludedSizes.length > 0 ? "budget-exhausted" : "no-match";
    return {
      schemaVersion: "1",
      query: input.query.trim(),
      outcome,
      normalizedTerms: terms,
      document: {
        id: document.id,
        hash: document.documentHash,
        corpusRevision: document.corpusRevision,
        extractionRevision: document.extractionRevision,
      },
      appliedFilters: { sectionIds, pageRange, qualities, reviewStates, visual },
      contextBudget: {
        unit: "source-text-characters",
        maxCharacters,
        usedCharacters,
        omittedResultCount,
        exhausted: omittedResultCount > 0,
        minimumRequiredCharacters: outcome === "budget-exhausted" ? Math.min(...budgetExcludedSizes) : undefined,
      },
      results,
    };
  }

  listInquiryRoutes(): InquiryRoute[] {
    return inquiryRoutes.map((route) => ({ ...route, suggestedMoves: [...route.suggestedMoves] }));
  }

  private inquiryStaleness(
    row: Record<string, unknown>,
    evidence: InquiryEvidence[],
  ): { stale: boolean; staleReason?: string } {
    const document = this.getDocument(String(row.document_id));
    if (!document) return { stale: true, staleReason: "The source document is no longer available." };
    if (document.documentHash !== String(row.document_hash)) {
      return { stale: true, staleReason: "The source document hash changed after this inquiry was created." };
    }
    if (document.corpusRevision !== Number(row.corpus_revision)) {
      return { stale: true, staleReason: "The reviewed chapter map changed after this inquiry was created." };
    }
    const currentPassages = new Map(this.listPassages(document.id).map((passage) => [passage.id, passage]));
    if (evidence.some(({ passageId, contentHash }) => currentPassages.get(passageId)?.contentHash !== contentHash)) {
      return { stale: true, staleReason: "One or more cited passages changed after this inquiry was created." };
    }
    return { stale: false };
  }

  getInquirySession(sessionId: string): InquirySession | undefined {
    const row = this.database.prepare("SELECT * FROM inquiry_sessions WHERE id = ?").get(sessionId);
    if (!row) return undefined;
    const evidence = JSON.parse(String(row.evidence_json)) as InquiryEvidence[];
    const steps = this.database
      .prepare("SELECT * FROM inquiry_steps WHERE session_id = ? ORDER BY step_sequence")
      .all(sessionId)
      .map(normalizeInquiryStep);
    const staleness = this.inquiryStaleness(row, evidence);
    return {
      schemaVersion: "1",
      id: String(row.id),
      documentId: String(row.document_id),
      documentHash: String(row.document_hash),
      corpusRevision: Number(row.corpus_revision),
      route: JSON.parse(String(row.route_json)) as InquiryRoute,
      objective: String(row.objective),
      title: String(row.title),
      status: String(row.status) as InquirySession["status"],
      ...staleness,
      evidence,
      steps,
      currentStepId: steps.find(({ status }) => status === "pending")?.id,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at === null ? undefined : String(row.completed_at),
    };
  }

  listInquirySessions(documentId: string): InquirySession[] {
    const document = this.getDocument(documentId);
    if (!document) throw new Error(`Unknown document: ${documentId}`);
    return this.database
      .prepare("SELECT id FROM inquiry_sessions WHERE document_id = ? ORDER BY updated_at DESC, id")
      .all(documentId)
      .map(({ id }) => this.getInquirySession(String(id))!);
  }

  async createInquirySession(input: CreateInquiryInput, idempotencyKey: string): Promise<InquirySession> {
    if (!idempotencyKey.trim() || idempotencyKey.length > 200) {
      throw new Error("An idempotency key of at most 200 characters is required");
    }
    if (!input || typeof input !== "object" || typeof input.documentId !== "string") {
      throw new Error("A documentId is required");
    }
    const document = this.getDocument(input.documentId);
    if (!document) throw new Error(`Unknown document: ${input.documentId}`);
    await this.verifyDocumentAsset(document.id);
    const route = inquiryRoute(input.routeId);
    if (!route) throw new Error("Inquiry route must be understand, challenge, apply, or reflect");
    const objective = typeof input.objective === "string" ? input.objective.trim() : "";
    if (objective.length < 3 || objective.length > 500) {
      throw new Error("Inquiry objective must be from 3 to 500 characters");
    }
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : objective.slice(0, 100);
    if (title.length > 120) throw new Error("Inquiry title must be at most 120 characters");
    const maxEvidenceCharacters = input.maxEvidenceCharacters ?? 6_000;
    if (!Number.isSafeInteger(maxEvidenceCharacters) || maxEvidenceCharacters < 512 || maxEvidenceCharacters > 12_000) {
      throw new Error("Inquiry evidence budget must be an integer from 512 to 12,000 characters");
    }
    const requestHash = sha256(JSON.stringify({
      documentId: document.id,
      documentHash: document.documentHash,
      corpusRevision: document.corpusRevision,
      routeId: route.id,
      objective,
      title,
      maxEvidenceCharacters,
    }));
    const replay = this.database.prepare("SELECT id, request_hash FROM inquiry_sessions WHERE idempotency_key = ?").get(idempotencyKey);
    if (replay) {
      if (String(replay.request_hash) !== requestHash) throw new Error("Idempotency key was already used for a different inquiry request");
      return this.getInquirySession(String(replay.id))!;
    }

    const search = await this.searchQuery({
      documentId: document.id,
      query: objective,
      sourceRevision: {
        documentHash: document.documentHash,
        corpusRevision: document.corpusRevision,
        extractionRevision: document.extractionRevision,
      },
      filters: { reviewStates: ["accepted"] },
      limit: 4,
      contextBudget: { maxCharacters: maxEvidenceCharacters },
    });
    if (search.outcome !== "matches" || search.results.length === 0) {
      throw new Error("No accepted source passage supports this inquiry yet; revise the objective or review more chapter boundaries");
    }
    const evidence: InquiryEvidence[] = search.results.map((result) => ({
      passageId: result.passage.id,
      sectionId: result.section.id,
      sectionTitle: result.section.title,
      pages: result.passage.pages,
      contentHash: result.passage.contentHash,
      preferredEvidenceId: result.preferredEvidenceId,
      evidence: result.evidence,
      snippet: result.snippet,
    }));
    const createdAt = new Date().toISOString();
    const id = `inq-${sha256(`${document.id}\0${idempotencyKey}`).slice("sha256:".length, "sha256:".length + 20)}`;
    const stepId = `${id}-step-1`;
    this.database.exec("BEGIN");
    try {
      this.database
        .prepare(
          `INSERT INTO inquiry_sessions
           (id, document_id, document_hash, corpus_revision, route_json, objective, title, status,
            evidence_json, idempotency_key, request_hash, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          id,
          document.id,
          document.documentHash,
          document.corpusRevision,
          JSON.stringify(route),
          objective,
          title,
          JSON.stringify(evidence),
          idempotencyKey,
          requestHash,
          createdAt,
          createdAt,
        );
      this.database
        .prepare(
          `INSERT INTO inquiry_steps
           (id, session_id, step_sequence, prompt, purpose, status, response, response_kind,
            evidence_passage_ids_json, next_move, created_at, answered_at, updated_at)
           VALUES (?, ?, 1, ?, ?, 'pending', NULL, NULL, '[]', NULL, ?, NULL, NULL)`,
        )
        .run(stepId, id, route.openingPrompt, "Establish a source-grounded starting point.", createdAt);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getInquirySession(id)!;
  }

  answerInquiryStep(sessionId: string, stepId: string, input: AnswerInquiryInput): InquirySession {
    const session = this.getInquirySession(sessionId);
    if (!session) throw new Error(`Unknown inquiry: ${sessionId}`);
    if (session.status !== "active") throw new Error("This inquiry is already complete");
    if (session.stale) throw new SourceRevisionConflictError(session.documentId, session.staleReason ?? "Inquiry evidence is stale");
    if (session.currentStepId !== stepId) throw new Error("Only the current pending inquiry step can advance the session");
    const response = typeof input.response === "string" ? input.response.trim() : "";
    if (!response || response.length > 20_000) throw new Error("Inquiry response must be from 1 to 20,000 characters");
    if (input.responseKind !== "grounded-interpretation" && input.responseKind !== "personal-reflection") {
      throw new Error("Response kind must distinguish grounded interpretation from personal reflection");
    }
    const evidencePassageIds = [...new Set(input.evidencePassageIds ?? [])];
    const allowedEvidence = new Set(session.evidence.map(({ passageId }) => passageId));
    if (evidencePassageIds.some((id) => !allowedEvidence.has(id))) throw new Error("Every cited passage must belong to this inquiry");
    if (input.responseKind === "grounded-interpretation" && evidencePassageIds.length === 0) {
      throw new Error("A grounded interpretation must cite at least one selected passage");
    }
    if (!(["deepen", "challenge", "connect", "apply", "synthesize", "complete"] as const).includes(input.nextMove)) {
      throw new Error("Choose a valid next inquiry move");
    }
    if (session.steps.length >= 8 && input.nextMove !== "complete") {
      throw new Error("This bounded inquiry has reached eight steps; complete it or start a new session");
    }
    const answeredAt = new Date().toISOString();
    this.database.exec("BEGIN");
    try {
      this.database
        .prepare(
          `UPDATE inquiry_steps SET status = 'answered', response = ?, response_kind = ?,
           evidence_passage_ids_json = ?, next_move = ?, answered_at = ?, updated_at = ?
           WHERE id = ? AND session_id = ?`,
        )
        .run(response, input.responseKind, JSON.stringify(evidencePassageIds), input.nextMove, answeredAt, answeredAt, stepId, sessionId);
      if (input.nextMove === "complete") {
        this.database
          .prepare("UPDATE inquiry_sessions SET status = 'completed', updated_at = ?, completed_at = ? WHERE id = ?")
          .run(answeredAt, answeredAt, sessionId);
      } else {
        const next = nextInquiryPrompt(input.nextMove, session.objective);
        const sequence = session.steps.length + 1;
        this.database
          .prepare(
            `INSERT INTO inquiry_steps
             (id, session_id, step_sequence, prompt, purpose, status, response, response_kind,
              evidence_passage_ids_json, next_move, created_at, answered_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, '[]', NULL, ?, NULL, NULL)`,
          )
          .run(`${sessionId}-step-${sequence}`, sessionId, sequence, next.prompt, next.purpose, answeredAt);
        this.database.prepare("UPDATE inquiry_sessions SET updated_at = ? WHERE id = ?").run(answeredAt, sessionId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getInquirySession(sessionId)!;
  }

  editInquiryStep(
    sessionId: string,
    stepId: string,
    input: Pick<AnswerInquiryInput, "response" | "responseKind" | "evidencePassageIds">,
  ): InquirySession {
    const session = this.getInquirySession(sessionId);
    if (!session) throw new Error(`Unknown inquiry: ${sessionId}`);
    const step = session.steps.find(({ id }) => id === stepId);
    if (!step || step.status !== "answered") throw new Error("Only an answered inquiry step can be edited");
    const response = typeof input.response === "string" ? input.response.trim() : "";
    if (!response || response.length > 20_000) throw new Error("Inquiry response must be from 1 to 20,000 characters");
    if (input.responseKind !== "grounded-interpretation" && input.responseKind !== "personal-reflection") {
      throw new Error("Response kind must distinguish grounded interpretation from personal reflection");
    }
    const evidencePassageIds = [...new Set(input.evidencePassageIds ?? [])];
    const allowedEvidence = new Set(session.evidence.map(({ passageId }) => passageId));
    if (evidencePassageIds.some((id) => !allowedEvidence.has(id))) throw new Error("Every cited passage must belong to this inquiry");
    if (input.responseKind === "grounded-interpretation" && evidencePassageIds.length === 0) {
      throw new Error("A grounded interpretation must cite at least one selected passage");
    }
    const updatedAt = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE inquiry_steps SET response = ?, response_kind = ?, evidence_passage_ids_json = ?, updated_at = ?
         WHERE id = ? AND session_id = ?`,
      )
      .run(response, input.responseKind, JSON.stringify(evidencePassageIds), updatedAt, stepId, sessionId);
    this.database.prepare("UPDATE inquiry_sessions SET updated_at = ? WHERE id = ?").run(updatedAt, sessionId);
    return this.getInquirySession(sessionId)!;
  }

  deleteInquirySession(sessionId: string): boolean {
    return Number(this.database.prepare("DELETE FROM inquiry_sessions WHERE id = ?").run(sessionId).changes) > 0;
  }

  exportInquiryJson(sessionId: string): InquirySession {
    const session = this.getInquirySession(sessionId);
    if (!session) throw new Error(`Unknown inquiry: ${sessionId}`);
    return session;
  }

  exportInquiryMarkdown(sessionId: string): string {
    const session = this.getInquirySession(sessionId);
    if (!session) throw new Error(`Unknown inquiry: ${sessionId}`);
    const lines = [
      `# ${session.title}`,
      "",
      `Objective: ${session.objective}`,
      `Route: ${session.route.title} (v${session.route.version})`,
      `Source: ${session.documentHash} · corpus revision ${session.corpusRevision}`,
      `Status: ${session.status}${session.stale ? ` · STALE — ${session.staleReason}` : " · current"}`,
      "",
      "## Cited source context",
      "",
    ];
    for (const evidence of session.evidence) {
      lines.push(
        `- ${evidence.sectionTitle}, pp. ${evidence.pages[0]}–${evidence.pages[1]} — passage \`${evidence.passageId}\``,
        `  - ${evidence.contentHash}`,
        `  - anchors: ${evidence.evidence.map(({ id }) => id).join(", ")}`,
      );
    }
    lines.push("", "## Inquiry", "");
    for (const step of session.steps) {
      lines.push(`### ${step.sequence}. ${step.purpose}`, "", step.prompt, "");
      if (step.response) {
        const citedEvidence = step.evidencePassageIds
          .map((passageId) => session.evidence.find((item) => item.passageId === passageId))
          .filter((item): item is InquiryEvidence => Boolean(item));
        lines.push(
          `**${step.responseKind === "grounded-interpretation" ? "Grounded interpretation" : "Personal reflection"}**`,
          "",
          step.response,
          "",
          `Evidence passages: ${step.evidencePassageIds.length ? step.evidencePassageIds.map((id) => `\`${id}\``).join(", ") : "none — user-authored reflection"}`,
          ...(citedEvidence.length ? [`Preferred source anchors: ${citedEvidence.map(({ preferredEvidenceId }) => `\`${preferredEvidenceId}\``).join(", ")}`] : []),
          "",
        );
      } else {
        lines.push("_Pending._", "");
      }
    }
    lines.push("---", "", "Book text is untrusted source material. Interpretations and reflections are derived or user-authored; verify citations before reuse.", "");
    return lines.join("\n");
  }

  corpusSummary(documentId: string): CorpusSummary {
    const document = this.getDocument(documentId);
    if (!document) throw new Error(`Unknown document: ${documentId}`);
    const sections = this.listSections(documentId);
    const passageCount = Number(
      this.database.prepare("SELECT COUNT(*) AS count FROM passages WHERE document_id = ? AND status = 'current'").get(documentId)?.count ?? 0,
    );
    const pages = this.listPages(documentId);
    const reviewRequiredPages = pages.filter(({ quality }) => quality === "review-needed").map(({ pageNumber }) => pageNumber);
    const ocrRequiredPages = pages.filter(({ quality }) => quality === "ocr-required").map(({ pageNumber }) => pageNumber);
    const blockers: string[] = [];
    if (ocrRequiredPages.length) blockers.push(`OCR required on ${ocrRequiredPages.length} page${ocrRequiredPages.length === 1 ? "" : "s"}.`);
    if (passageCount === 0) blockers.push("No citation-ready passages are available.");
    return {
      documentId,
      structureRevision: document.corpusRevision,
      sectionCount: sections.length,
      passageCount,
      tocEntryCount: detectTocEntries(this.corpusBlocks(documentId)).length,
      proposedSectionCount: sections.filter(({ status }) => status === "proposed").length,
      acceptedSectionCount: sections.filter(({ status }) => status === "accepted").length,
      excludedSectionCount: sections.filter(({ status }) => status === "excluded").length,
      reviewRequiredPages,
      ocrRequiredPages,
      ready: blockers.length === 0,
      blockers,
    };
  }

  getCorpus(documentId: string): { summary: CorpusSummary; sections: DocumentSection[]; passages: DocumentPassage[] } {
    return {
      summary: this.corpusSummary(documentId),
      sections: this.listSections(documentId),
      passages: this.listPassages(documentId),
    };
  }

  getCorpusOverview(documentId: string): { summary: CorpusSummary; sections: DocumentSection[] } {
    return {
      summary: this.corpusSummary(documentId),
      sections: this.listSections(documentId),
    };
  }

  saveProgress(documentId: string, pageNumber: number, blockId?: string): ReadingProgress {
    const document = this.getDocument(documentId);
    if (!document || pageNumber < 1 || pageNumber > document.pageCount) throw new Error("Invalid reading position");
    if (blockId) {
      const block = this.database.prepare("SELECT document_id FROM blocks WHERE id = ?").get(blockId);
      if (!block || String(block.document_id) !== documentId) throw new Error("Progress block is outside the document");
    }
    const updatedAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO reading_progress (document_id, page_number, block_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(document_id) DO UPDATE SET
           page_number = excluded.page_number, block_id = excluded.block_id, updated_at = excluded.updated_at`,
      )
      .run(documentId, pageNumber, blockId ?? null, updatedAt);
    return { documentId, pageNumber, blockId, updatedAt };
  }

  getProgress(documentId: string): ReadingProgress | undefined {
    const row = this.database.prepare("SELECT * FROM reading_progress WHERE document_id = ?").get(documentId);
    return row
      ? {
          documentId: String(row.document_id),
          pageNumber: Number(row.page_number),
          blockId: row.block_id ? String(row.block_id) : undefined,
          updatedAt: String(row.updated_at),
        }
      : undefined;
  }

  addAnnotation(
    documentId: string,
    blockId: string,
    kind: Annotation["kind"],
    content: string,
    authorship: Annotation["authorship"] = "user",
  ): Annotation {
    const block = this.database.prepare("SELECT document_id FROM blocks WHERE id = ?").get(blockId);
    if (!block || String(block.document_id) !== documentId) throw new Error("Annotation block is outside the document");
    if (!content.trim()) throw new Error("Annotation content is required");
    const createdAt = new Date().toISOString();
    const result = this.database
      .prepare(
        "INSERT INTO annotations (document_id, block_id, kind, authorship, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(documentId, blockId, kind, authorship, content.trim(), createdAt);
    return { id: Number(result.lastInsertRowid), documentId, blockId, kind, authorship, content: content.trim(), createdAt };
  }

  listAnnotations(documentId: string): Annotation[] {
    return this.database
      .prepare("SELECT * FROM annotations WHERE document_id = ? ORDER BY id")
      .all(documentId)
      .map((row) => ({
        id: Number(row.id),
        documentId: String(row.document_id),
        blockId: String(row.block_id),
        kind: String(row.kind) as Annotation["kind"],
        authorship: String(row.authorship) as Annotation["authorship"],
        content: String(row.content),
        createdAt: String(row.created_at),
      }));
  }

  exportAnnotationsMarkdown(documentId: string): string {
    const document = this.getDocument(documentId);
    if (!document) throw new Error(`Unknown document: ${documentId}`);
    const blocks = new Map(this.listBlocks(documentId).map((block) => [block.id, block]));
    const lines = [`# Notes — ${document.originalName}`, "", `Source: ${document.documentHash}`, ""];
    for (const annotation of this.listAnnotations(documentId)) {
      const block = blocks.get(annotation.blockId)!;
      lines.push(
        `## Page ${block.pageNumber} · ${annotation.authorship} ${annotation.kind}`,
        "",
        `> ${block.sourceText.replaceAll("\n", " ")}`,
        "",
        annotation.content,
        "",
        "```json scribe-skill-evidence",
        JSON.stringify(this.evidenceForBlock(block.id), null, 2),
        "```",
        "",
      );
    }
    return `${lines.join("\n")}\n`;
  }

  exportAnnotationsEvidence(documentId: string): {
    schemaVersion: 1;
    documentHash: string;
    annotations: Array<Annotation & { sourceText: string; evidence: EvidenceAnchor }>;
  } {
    const document = this.getDocument(documentId);
    if (!document) throw new Error(`Unknown document: ${documentId}`);
    const blocks = new Map(this.listBlocks(documentId).map((block) => [block.id, block]));
    return {
      schemaVersion: 1,
      documentHash: document.documentHash,
      annotations: this.listAnnotations(documentId).map((annotation) => {
        const block = blocks.get(annotation.blockId)!;
        return { ...annotation, sourceText: block.sourceText, evidence: this.evidenceForBlock(block.id) };
      }),
    };
  }
}
