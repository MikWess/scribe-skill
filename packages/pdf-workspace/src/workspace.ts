import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EvidenceAnchor } from "@scribe-skill/core";
import { sha256 } from "@scribe-skill/core";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type PageQuality = "good" | "review-needed" | "ocr-required";
export type BlockStatus = "included" | "excluded" | "rejected";

export interface ImportedDocument {
  id: string;
  documentHash: string;
  originalName: string;
  assetPath: string;
  pageCount: number;
  extractionRevision: number;
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

export interface DocumentSection {
  id: string;
  documentId: string;
  title: string;
  startPage: number;
  endPage: number;
  order: number;
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
    return workspace;
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > 4) throw new Error(`Workspace schema ${version} is newer than this app supports`);
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
          title TEXT NOT NULL,
          start_page INTEGER NOT NULL,
          end_page INTEGER NOT NULL,
          section_order INTEGER NOT NULL
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
        PRAGMA user_version = 4;
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
        this.database
          .prepare(
            `INSERT INTO pages
             (document_id, page_number, width, height, confidence, quality)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, pageNumber, viewport.width, viewport.height, quality.confidence, quality.quality);

        for (const block of rawBlocks) {
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
              block.order,
              quality.confidence,
              block.x,
              block.y,
              block.width,
              block.height,
              sha256(block.text),
              revision,
            );
        }
        this.database
          .prepare(
            `INSERT INTO sections (id, document_id, title, start_page, end_page, section_order)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(`${id}-section-p${pageNumber}`, id, `Page ${pageNumber}`, pageNumber, pageNumber, pageNumber - 1);
      }
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

  editBlock(
    blockId: string,
    patch: { text?: string; order?: number; status?: BlockStatus },
    note: string,
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
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return normalizeBlock(this.database.prepare("SELECT * FROM blocks WHERE id = ?").get(blockId)!);
  }

  reorderBlock(blockId: string, direction: -1 | 1): ExtractedBlock[] {
    const currentRow = this.database.prepare("SELECT * FROM blocks WHERE id = ?").get(blockId);
    if (!currentRow) throw new Error(`Unknown block: ${blockId}`);
    const current = normalizeBlock(currentRow);
    const siblings = this.listBlocks(current.documentId, current.pageNumber);
    const index = siblings.findIndex(({ id }) => id === blockId);
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= siblings.length) return siblings;
    const target = siblings[targetIndex]!;
    const createdAt = new Date().toISOString();

    this.database.exec("BEGIN");
    try {
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

  listSections(documentId: string): DocumentSection[] {
    return this.database
      .prepare("SELECT * FROM sections WHERE document_id = ? ORDER BY section_order")
      .all(documentId)
      .map((row) => ({
        id: String(row.id),
        documentId: String(row.document_id),
        title: String(row.title),
        startPage: Number(row.start_page),
        endPage: Number(row.end_page),
        order: Number(row.section_order),
      }));
  }

  getSection(sectionId: string): DocumentSection | undefined {
    const row = this.database.prepare("SELECT document_id FROM sections WHERE id = ?").get(sectionId);
    return row ? this.listSections(String(row.document_id)).find(({ id }) => id === sectionId) : undefined;
  }

  updateSection(
    sectionId: string,
    patch: Partial<Pick<DocumentSection, "title" | "startPage" | "endPage" | "order">>,
  ): DocumentSection {
    const row = this.database.prepare("SELECT * FROM sections WHERE id = ?").get(sectionId);
    if (!row) throw new Error(`Unknown section: ${sectionId}`);
    const current = this.listSections(String(row.document_id)).find(({ id }) => id === sectionId)!;
    const next = { ...current, ...patch };
    const document = this.getDocument(next.documentId)!;
    if (!next.title.trim()) throw new Error("Section title is required");
    if (
      !Number.isSafeInteger(next.startPage) ||
      !Number.isSafeInteger(next.endPage) ||
      next.startPage < 1 ||
      next.endPage < next.startPage ||
      next.endPage > document.pageCount
    ) {
      throw new Error("Section page range is outside the document");
    }
    this.database
      .prepare(
        "UPDATE sections SET title = ?, start_page = ?, end_page = ?, section_order = ? WHERE id = ?",
      )
      .run(next.title.trim(), next.startPage, next.endPage, next.order, sectionId);
    return next;
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
