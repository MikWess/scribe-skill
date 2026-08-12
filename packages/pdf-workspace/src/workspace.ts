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
    if (version > 2) throw new Error(`Workspace schema ${version} is newer than this app supports`);
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
        PRAGMA user_version = 2;
        COMMIT;
      `);
    }
    if (version === 1) {
      this.database.exec("ALTER TABLE pages ADD COLUMN render_hash TEXT; PRAGMA user_version = 2;");
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
}
