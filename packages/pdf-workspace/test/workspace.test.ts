import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { resolveEvidenceAnchor } from "@scribe-skill/core";
import { CorpusRevisionConflictError, PdfWorkspace, WorkspaceIntegrityError } from "@scribe-skill/pdf-workspace";

async function createDigitalPdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600, 800]);
  page.drawText("Evidence Systems", { x: 50, y: 750, size: 22, font });
  page.drawText("Durable citations bind claims to source spans.", {
    x: 50,
    y: 690,
    size: 11,
    font,
  });
  page.drawText("Extraction confidence flags uncertain pages.", {
    x: 50,
    y: 660,
    size: 11,
    font,
  });
  page.drawText("Graph edges remain derived context.", {
    x: 330,
    y: 690,
    size: 11,
    font,
  });
  page.drawText("Agents verify exact source passages.", {
    x: 330,
    y: 660,
    size: 11,
    font,
  });
  const secondPage = pdf.addPage([600, 800]);
  secondPage.drawText("A simple one-column page should be ready without repair.", {
    x: 50,
    y: 720,
    size: 12,
    font,
  });
  secondPage.drawText("Its evidence remains attached to the original source block.", {
    x: 50,
    y: 690,
    size: 12,
    font,
  });
  await writeFile(path, await pdf.save());
}

async function createScannedLikePdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  page.drawRectangle({ x: 40, y: 40, width: 520, height: 720, color: rgb(0.94, 0.94, 0.92) });
  page.drawLine({ start: { x: 80, y: 700 }, end: { x: 520, y: 700 }, thickness: 8 });
  await writeFile(path, await pdf.save());
}

async function createChapteredPdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const contents = pdf.addPage([600, 800]);
  contents.drawText("CONTENTS", { x: 50, y: 750, size: 24, font });
  contents.drawText("Chapter 1 Diagnosis ........ 2", { x: 50, y: 700, size: 11, font });
  contents.drawText("Chapter 2 Guiding Policy ........ 4", { x: 50, y: 670, size: 11, font });
  const first = pdf.addPage([600, 800]);
  first.drawText("Strategy Handbook", { x: 50, y: 780, size: 8, font });
  first.drawText("Chapter 1 Diagnosis", { x: 50, y: 750, size: 24, font });
  first.drawText("A strategy begins by identifying the central challenge.", { x: 50, y: 690, size: 11, font });
  const continuation = pdf.addPage([600, 800]);
  continuation.drawText("Diagnosis separates symptoms from the underlying problem.", { x: 50, y: 720, size: 11, font });
  const second = pdf.addPage([600, 800]);
  second.drawText("Chapter 2 Guiding Policy", { x: 50, y: 750, size: 24, font });
  second.drawText("A guiding policy establishes an approach to the challenge.", { x: 50, y: 690, size: 11, font });
  await writeFile(path, await pdf.save());
}

async function createMultiPageTocPdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const contents = pdf.addPage([600, 800]);
  contents.drawText("CONTENTS", { x: 50, y: 750, size: 24, font });
  contents.drawText("Chapter 1 Diagnosis ........ 4", { x: 50, y: 700, size: 11, font });
  const contentsContinuation = pdf.addPage([600, 800]);
  contentsContinuation.drawText("Chapter 2 Policy ........ 5", { x: 50, y: 700, size: 11, font });
  contentsContinuation.drawText("Chapter 3 Actions ........ 6", { x: 50, y: 670, size: 11, font });
  const preface = pdf.addPage([600, 800]);
  preface.drawText("Book clubs often discuss strategy without a shared diagnosis.", { x: 50, y: 700, size: 11, font });
  for (const [index, title] of ["Chapter 1 Diagnosis", "Chapter 2 Policy", "Chapter 3 Actions"].entries()) {
    const page = pdf.addPage([600, 800]);
    page.drawText(title, { x: 50, y: 750, size: 24, font });
    page.drawText(`Body text for chapter ${index + 1}.`, { x: 50, y: 690, size: 11, font });
  }
  await writeFile(path, await pdf.save());
}

async function createTocOnlySamePagePdf(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const contents = pdf.addPage([600, 800]);
  contents.drawText("CONTENTS", { x: 50, y: 750, size: 24, font });
  contents.drawText("First idea ........ 2", { x: 50, y: 700, size: 11, font });
  contents.drawText("Second idea ........ 2", { x: 50, y: 670, size: 11, font });
  const body = pdf.addPage([600, 800]);
  body.drawText("Both short sections begin on this printed page.", { x: 50, y: 700, size: 11, font });
  await writeFile(path, await pdf.save());
}

test("imports a PDF into a content-addressed, evidence-linked workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-workspace-"));
  const pdfPath = join(root, "evidence-systems.pdf");
  await createDigitalPdf(pdfPath);
  const workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });

  const document = await workspace.importPdf(pdfPath);
  const duplicate = await workspace.importPdf(pdfPath);
  const pages = workspace.listPages(document.id);
  const blocks = workspace.listBlocks(document.id);
  const anchor = workspace.evidenceForBlock(blocks[0]!.id);

  assert.equal(duplicate.id, document.id);
  assert.equal(document.pageCount, 2);
  assert.deepEqual(pages.map(({ quality }) => quality), ["review-needed", "good"]);
  assert.ok(blocks.length >= 5);
  assert.deepEqual(
    blocks.filter(({ pageNumber }) => pageNumber === 1).map(({ sourceText }) => sourceText),
    [
      "Evidence Systems",
      "Durable citations bind claims to source spans.",
      "Extraction confidence flags uncertain pages.",
      "Graph edges remain derived context.",
      "Agents verify exact source passages.",
    ],
  );
  assert.equal(anchor.documentHash, document.documentHash);
  assert.equal(anchor.page, 1);
  assert.equal(anchor.contentHash, blocks[0]?.contentHash);
  assert.ok((await stat(document.assetPath)).isFile());
  assert.deepEqual(new Uint8Array(await readFile(document.assetPath)), new Uint8Array(await readFile(pdfPath)));
});

test("persists repair history while preserving immutable extracted text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-repair-"));
  const pdfPath = join(root, "repair.pdf");
  await createDigitalPdf(pdfPath);
  let workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    try {
      workspace.close();
    } catch {
      // Already closed before reopening.
    }
    await rm(root, { recursive: true, force: true });
  });
  const document = await workspace.importPdf(pdfPath);
  const original = workspace.listBlocks(document.id)[1]!;
  workspace.editBlock(
    original.id,
    { text: "Corrected reading order text.", order: 99, status: "excluded" },
    "Two-column extraction repair",
    document.corpusRevision,
  );
  workspace.close();

  workspace = await PdfWorkspace.open(join(root, "library"));
  const repaired = workspace.listBlocks(document.id).find(({ id }) => id === original.id)!;
  const edits = workspace.listBlockEdits(original.id);
  const inspection = await workspace.inspectPage(document.id, 1);

  assert.equal(repaired.sourceText, original.sourceText);
  assert.equal(repaired.currentText, "Corrected reading order text.");
  assert.equal(repaired.currentOrder, 99);
  assert.equal(repaired.status, "excluded");
  assert.equal(edits[0]?.previousText, original.sourceText);
  assert.equal(edits[0]?.note, "Two-column extraction repair");
  const anchor = workspace.evidenceForBlock(original.id);
  assert.equal(anchor.contentHash, original.contentHash);
  assert.equal(anchor.characterRange.end, original.sourceText.length);
  assert.equal(anchor.pageImageHash, inspection.renderHash);
  assert.ok((await stat(inspection.renderPath)).isFile());
  assert.equal(inspection.blocks.find(({ id }) => id === original.id)?.currentText, "Corrected reading order text.");
  assert.deepEqual([...new Uint8Array(await readFile(inspection.renderPath)).slice(0, 8)], [
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
});

test("moves a block atomically without duplicate reading-order positions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-reorder-"));
  const pdfPath = join(root, "reorder.pdf");
  await createDigitalPdf(pdfPath);
  let workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    try { workspace.close(); } catch { /* already closed */ }
    await rm(root, { recursive: true, force: true });
  });
  const document = await workspace.importPdf(pdfPath);
  const before = workspace.listBlocks(document.id, 1);
  const movedId = before[2]!.id;
  workspace.reorderBlock(movedId, -1, document.corpusRevision);
  workspace.close();
  workspace = await PdfWorkspace.open(join(root, "library"));
  const after = workspace.listBlocks(document.id, 1);

  assert.equal(after[1]?.id, movedId);
  assert.equal(new Set(after.map(({ currentOrder }) => currentOrder)).size, after.length);
  assert.match(workspace.listBlockEdits(movedId).at(-1)?.note ?? "", /move earlier/);
});

test("flags an image-only page for OCR instead of claiming searchable text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-ocr-"));
  const pdfPath = join(root, "scanned.pdf");
  await createScannedLikePdf(pdfPath);
  const workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });

  const document = await workspace.importPdf(pdfPath);

  assert.deepEqual(workspace.listPages(document.id).map(({ quality }) => quality), ["ocr-required"]);
  assert.deepEqual(workspace.listBlocks(document.id), []);
});

test("produces the same stable block ids in independent workspaces", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-stability-"));
  const pdfPath = join(root, "stable.pdf");
  await createDigitalPdf(pdfPath);
  const first = await PdfWorkspace.open(join(root, "first"));
  const second = await PdfWorkspace.open(join(root, "second"));
  t.after(async () => {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  });

  const firstDocument = await first.importPdf(pdfPath);
  const secondDocument = await second.importPdf(pdfPath);

  assert.deepEqual(
    first.listBlocks(firstDocument.id).map(({ id, contentHash }) => ({ id, contentHash })),
    second.listBlocks(secondDocument.id).map(({ id, contentHash }) => ({ id, contentHash })),
  );
});

test("detects stable semantic chapters and citation-ready passages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-corpus-"));
  const pdfPath = join(root, "strategy.pdf");
  await createChapteredPdf(pdfPath);
  const first = await PdfWorkspace.open(join(root, "first"));
  const second = await PdfWorkspace.open(join(root, "second"));
  t.after(async () => {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  });

  const firstDocument = await first.importPdf(pdfPath);
  const secondDocument = await second.importPdf(pdfPath);
  const firstCorpus = first.getCorpus(firstDocument.id);
  const secondCorpus = second.getCorpus(secondDocument.id);

  assert.deepEqual(
    firstCorpus.sections.map(({ title }) => title),
    ["CONTENTS", "Chapter 1 Diagnosis", "Chapter 2 Guiding Policy"],
  );
  assert.deepEqual(
    firstCorpus.sections.map(({ id, startPage, endPage }) => ({ id, startPage, endPage })),
    secondCorpus.sections.map(({ id, startPage, endPage }) => ({ id, startPage, endPage })),
  );
  assert.deepEqual(
    firstCorpus.passages.map(({ id, contentHash }) => ({ id, contentHash })),
    secondCorpus.passages.map(({ id, contentHash }) => ({ id, contentHash })),
  );
  assert.ok(firstCorpus.passages.every(({ evidence }) => evidence.length > 0));
  assert.equal(firstCorpus.summary.tocEntryCount, 2);
  assert.equal(firstCorpus.summary.ocrRequiredPages.length, 0);
  assert.equal(firstCorpus.summary.ready, true);
});

test("suppresses a contiguous multi-page table of contents and sentence-like book text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-corpus-toc-span-"));
  const pdfPath = join(root, "multi-toc.pdf");
  await createMultiPageTocPdf(pdfPath);
  const workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });
  const document = await workspace.importPdf(pdfPath);
  const corpus = workspace.getCorpus(document.id);

  assert.equal(corpus.summary.tocEntryCount, 3);
  assert.deepEqual(corpus.sections.map(({ title }) => title), [
    "CONTENTS",
    "Chapter 1 Diagnosis",
    "Chapter 2 Policy",
    "Chapter 3 Actions",
  ]);
  assert.ok(corpus.sections.every(({ title }) => !title.startsWith("Book clubs")));
});

test("imports TOC-only books with multiple entries declared on the same page", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-corpus-toc-same-page-"));
  const pdfPath = join(root, "same-page-toc.pdf");
  await createTocOnlySamePagePdf(pdfPath);
  const workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });
  const document = await workspace.importPdf(pdfPath);
  const sections = workspace.listSections(document.id);

  assert.deepEqual(sections.map(({ title }) => title), ["CONTENTS", "First idea", "Second idea"]);
  assert.equal(new Set(sections.map(({ id }) => id)).size, sections.length);
});

test("persists chapter review, split, merge, and passage revisions across restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-corpus-edit-"));
  const pdfPath = join(root, "strategy.pdf");
  await createChapteredPdf(pdfPath);
  let workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    try { workspace.close(); } catch { /* already closed */ }
    await rm(root, { recursive: true, force: true });
  });

  const document = await workspace.importPdf(pdfPath);
  const chapter = workspace.listSections(document.id).find(({ title }) => title === "Chapter 1 Diagnosis")!;
  const initialPassageIds = workspace.listPassages(document.id).map(({ id }) => id);
  const accepted = workspace.updateSection(chapter.id, { title: "Diagnose the challenge", status: "accepted" }, document.corpusRevision);
  assert.equal(accepted.origin, "user");
  assert.equal(accepted.confidence, 1);
  assert.deepEqual(workspace.listPassages(document.id).map(({ id }) => id), initialPassageIds);
  const afterSplit = workspace.splitSection(accepted.id, 3, "Diagnosis continued", workspace.getDocument(document.id)!.corpusRevision);
  const continuation = afterSplit.find(({ title }) => title === "Diagnosis continued")!;
  assert.equal(continuation.startPage, 3);
  assert.deepEqual([...new Set(workspace.listIncludedBlocksForSection(accepted.id).map(({ pageNumber }) => pageNumber))], [2]);
  assert.deepEqual([...new Set(workspace.listIncludedBlocksForSection(continuation.id).map(({ pageNumber }) => pageNumber))], [3]);
  const afterMerge = workspace.mergeSections(accepted.id, continuation.id, workspace.getDocument(document.id)!.corpusRevision);
  assert.equal(afterMerge.find(({ id }) => id === accepted.id)?.endPage, 3);
  const beforeRepair = workspace.listPassages(document.id);
  const unaffectedSection = workspace.listSections(document.id).find(({ title }) => title === "Chapter 2 Guiding Policy")!;
  const unaffectedBefore = workspace.listPassages(document.id, unaffectedSection.id);
  const repairedBlock = workspace.listBlocks(document.id, 2).find(({ currentText }) => currentText.includes("central challenge"))!;
  const sourceAnchor = workspace.evidenceForBlock(repairedBlock.id);
  workspace.editBlock(
    repairedBlock.id,
    { text: "A strategy starts by diagnosing the central challenge." },
    "Clarify reading copy",
    workspace.getDocument(document.id)!.corpusRevision,
  );
  const afterRepair = workspace.listPassages(document.id);
  const passageHistory = workspace.listPassages(document.id, undefined, true);
  assert.notDeepEqual(afterRepair.map(({ id }) => id), beforeRepair.map(({ id }) => id));
  assert.ok(passageHistory.some(({ status }) => status === "stale"));
  assert.deepEqual(workspace.listPassages(document.id, unaffectedSection.id), unaffectedBefore);
  assert.equal(
    workspace.listPassages(document.id, unaffectedSection.id, true).filter(({ status }) => status === "stale").length,
    0,
  );
  assert.deepEqual(workspace.evidenceForBlock(repairedBlock.id), sourceAnchor);
  workspace.close();

  workspace = await PdfWorkspace.open(join(root, "library"));
  const reopened = workspace.getCorpus(document.id);
  assert.equal(reopened.sections.find(({ id }) => id === accepted.id)?.title, "Diagnose the challenge");
  assert.ok(reopened.passages.some(({ readingText }) => readingText.includes("starts by diagnosing")));
  assert.ok(reopened.passages.every(({ structureRevision }) => structureRevision <= reopened.summary.structureRevision));
});

test("preserves an exact start anchor when only the section end page changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-corpus-range-"));
  const pdfPath = join(root, "strategy.pdf");
  await createChapteredPdf(pdfPath);
  const workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });
  const document = await workspace.importPdf(pdfPath);
  const chapter = workspace.listSections(document.id).find(({ title }) => title === "Chapter 1 Diagnosis")!;
  const pageBlocks = workspace.listBlocks(document.id, chapter.startPage);
  assert.notEqual(chapter.startBlockId, pageBlocks[0]?.id);

  const updated = workspace.updateSection(chapter.id, { endPage: chapter.startPage }, document.corpusRevision);
  assert.equal(updated.startBlockId, chapter.startBlockId);
});

test("reparents nested sections when their parent is merged away", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-corpus-merge-parent-"));
  const pdfPath = join(root, "strategy.pdf");
  await createChapteredPdf(pdfPath);
  const workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });
  const document = await workspace.importPdf(pdfPath);
  const [contents, firstChapter, secondChapter] = workspace.listSections(document.id);
  workspace.updateSection(secondChapter!.id, { parentId: firstChapter!.id }, document.corpusRevision);
  assert.throws(
    () => workspace.updateSection(firstChapter!.id, { parentId: secondChapter!.id }, workspace.getDocument(document.id)!.corpusRevision),
    /hierarchy cycle/,
  );
  workspace.mergeSections(contents!.id, firstChapter!.id, workspace.getDocument(document.id)!.corpusRevision);

  assert.equal(workspace.getSection(secondChapter!.id)?.parentId, contents!.id);
});

test("rejects stale corpus mutations without overwriting a newer review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-corpus-conflict-"));
  const pdfPath = join(root, "strategy.pdf");
  await createChapteredPdf(pdfPath);
  const workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });
  const document = await workspace.importPdf(pdfPath);
  const section = workspace.listSections(document.id)[1]!;
  workspace.updateSection(section.id, { title: "First reviewer" }, document.corpusRevision);

  assert.throws(
    () => workspace.updateSection(section.id, { title: "Stale reviewer" }, document.corpusRevision),
    CorpusRevisionConflictError,
  );
  assert.equal(workspace.getSection(section.id)?.title, "First reviewer");
});

test("ignores patch fields that could move a section mutation onto another document", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-corpus-scope-"));
  const firstPath = join(root, "first.pdf");
  const secondPath = join(root, "second.pdf");
  await createDigitalPdf(firstPath);
  await createChapteredPdf(secondPath);
  const workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = await workspace.importPdf(firstPath);
  const second = await workspace.importPdf(secondPath);
  const section = workspace.listSections(first.id)[0]!;
  const malformedPatch = { title: "Still belongs to the first book", documentId: second.id };
  workspace.updateSection(section.id, malformedPatch, first.corpusRevision);

  assert.equal(workspace.getSection(section.id)?.documentId, first.id);
  assert.equal(workspace.getDocument(first.id)?.corpusRevision, first.corpusRevision + 1);
  assert.equal(workspace.getDocument(second.id)?.corpusRevision, second.corpusRevision);
});

test("keeps body passages when a user excludes the detected heading block", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-corpus-heading-exclusion-"));
  const pdfPath = join(root, "strategy.pdf");
  await createChapteredPdf(pdfPath);
  const workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });
  const document = await workspace.importPdf(pdfPath);
  const chapter = workspace.listSections(document.id).find(({ title }) => title === "Chapter 1 Diagnosis")!;
  const heading = workspace.listIncludedBlocksForSection(chapter.id)[0]!;
  workspace.editBlock(heading.id, { status: "excluded" }, "Remove repeated heading from reading copy", document.corpusRevision);

  const passage = workspace.listPassages(document.id, chapter.id)[0]!;
  assert.doesNotMatch(passage.readingText, /Chapter 1 Diagnosis/);
  assert.match(passage.readingText, /central challenge/);
  assert.deepEqual(
    passage.evidence.map(({ blockId }) => blockId),
    workspace.listIncludedBlocksForSection(chapter.id).map(({ id }) => id),
  );
});

test("reports OCR as a corpus blocker without fabricating passages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-corpus-ocr-"));
  const pdfPath = join(root, "scanned.pdf");
  await createScannedLikePdf(pdfPath);
  const workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });

  const document = await workspace.importPdf(pdfPath);
  const corpus = workspace.getCorpus(document.id);
  assert.equal(corpus.summary.ready, false);
  assert.deepEqual(corpus.summary.ocrRequiredPages, [1]);
  assert.match(corpus.summary.blockers.join(" "), /OCR required/);
  assert.deepEqual(corpus.passages, []);
});

test("migrates an untouched schema-4 page guide into the semantic corpus", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-corpus-migration-"));
  const library = join(root, "library");
  await mkdir(library, { recursive: true });
  const database = new DatabaseSync(join(library, "workspace.sqlite"));
  database.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY, document_hash TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL, asset_path TEXT NOT NULL, page_count INTEGER NOT NULL, extraction_revision INTEGER NOT NULL, imported_at TEXT NOT NULL);
    CREATE TABLE pages (document_id TEXT NOT NULL, page_number INTEGER NOT NULL, width REAL NOT NULL, height REAL NOT NULL, confidence REAL NOT NULL, quality TEXT NOT NULL, render_hash TEXT, PRIMARY KEY (document_id, page_number));
    CREATE TABLE blocks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, page_number INTEGER NOT NULL, source_text TEXT NOT NULL, current_text TEXT NOT NULL, original_order INTEGER NOT NULL, current_order INTEGER NOT NULL, status TEXT NOT NULL, confidence REAL NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, content_hash TEXT NOT NULL, extraction_revision INTEGER NOT NULL);
    CREATE TABLE sections (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, title TEXT NOT NULL, start_page INTEGER NOT NULL, end_page INTEGER NOT NULL, section_order INTEGER NOT NULL);
    CREATE TABLE annotations (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, block_id TEXT NOT NULL, kind TEXT NOT NULL, authorship TEXT NOT NULL DEFAULT 'user', content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE reading_progress (document_id TEXT PRIMARY KEY, page_number INTEGER NOT NULL, block_id TEXT, updated_at TEXT NOT NULL);
    INSERT INTO documents VALUES ('doc-legacy', 'sha256:legacy', 'legacy.pdf', '/tmp/legacy.pdf', 1, 1, '2026-01-01T00:00:00.000Z');
    INSERT INTO pages VALUES ('doc-legacy', 1, 600, 800, 0.95, 'good', NULL);
    INSERT INTO blocks VALUES ('doc-legacy-p1-b0', 'doc-legacy', 1, 'Legacy evidence remains cited.', 'Legacy evidence remains cited.', 0, 0, 'included', 0.95, 0.1, 0.1, 0.5, 0.02, 'sha256:legacy-block', 1);
    INSERT INTO sections VALUES ('doc-legacy-section-p1', 'doc-legacy', 'Page 1', 1, 1, 0);
    PRAGMA user_version = 4;
  `);
  database.close();
  const workspace = await PdfWorkspace.open(library);
  t.after(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });

  const corpus = workspace.getCorpus("doc-legacy");
  assert.equal(corpus.sections.length, 1);
  assert.equal(corpus.sections[0]?.title, "legacy");
  assert.equal(corpus.passages[0]?.sourceText, "Legacy evidence remains cited.");
  assert.equal(corpus.summary.structureRevision, 1);
  const migratedDatabase = new DatabaseSync(join(library, "workspace.sqlite"));
  const foreignKeys = migratedDatabase.prepare("PRAGMA foreign_key_list(sections)").all();
  assert.ok(foreignKeys.some((row) => row.from === "parent_id" && row.table === "sections" && row.on_delete === "SET NULL"));
  assert.deepEqual(migratedDatabase.prepare("PRAGMA foreign_key_check").all(), []);
  migratedDatabase.close();
});

test("rejects malformed input without adding it to the library", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-malformed-"));
  const pdfPath = join(root, "not-a-pdf.pdf");
  await writeFile(pdfPath, "not a PDF");
  const workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(() => workspace.importPdf(pdfPath));
  assert.equal(workspace.getDocument("doc-missing"), undefined);
});

test("detects a tampered content-addressed source before reuse or rendering", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-tamper-"));
  const pdfPath = join(root, "source.pdf");
  await createDigitalPdf(pdfPath);
  const workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    workspace.close();
    await rm(root, { recursive: true, force: true });
  });
  const document = await workspace.importPdf(pdfPath);
  await writeFile(document.assetPath, "tampered");

  await assert.rejects(() => workspace.importPdf(pdfPath), WorkspaceIntegrityError);
  await assert.rejects(() => workspace.inspectPage(document.id, 1), WorkspaceIntegrityError);
});

test("persists section edits, reading position, and portable cited notes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-reader-state-"));
  const pdfPath = join(root, "reader.pdf");
  await createDigitalPdf(pdfPath);
  let workspace = await PdfWorkspace.open(join(root, "library"));
  t.after(async () => {
    try {
      workspace.close();
    } catch {
      // Already closed during the restart step.
    }
    await rm(root, { recursive: true, force: true });
  });
  const document = await workspace.importPdf(pdfPath);
  const block = workspace.listBlocks(document.id, 1)[1]!;
  const section = workspace.updateSection(workspace.listSections(document.id)[0]!.id, {
    title: "Evidence foundations",
    startPage: 1,
    endPage: 2,
  }, document.corpusRevision);
  workspace.saveProgress(document.id, 1, block.id);
  workspace.addAnnotation(document.id, block.id, "note", "Use this when validating graph claims.");
  workspace.close();

  workspace = await PdfWorkspace.open(join(root, "library"));
  assert.equal(workspace.listSections(document.id)[0]?.title, "Evidence foundations");
  assert.equal(workspace.listSections(document.id)[0]?.endPage, 2);
  assert.equal(workspace.getProgress(document.id)?.blockId, block.id);
  const markdown = workspace.exportAnnotationsMarkdown(document.id);
  const evidenceExport = workspace.exportAnnotationsEvidence(document.id);
  assert.match(markdown, /Use this when validating graph claims/);
  assert.match(markdown, new RegExp(`"id": "anchor-${block.id}"`));
  assert.match(markdown, new RegExp(`"contentHash": "${block.contentHash}"`));
  assert.equal(evidenceExport.documentHash, document.documentHash);
  assert.equal(evidenceExport.annotations[0]?.authorship, "user");
  assert.deepEqual(evidenceExport.annotations[0]?.evidence, workspace.evidenceForBlock(block.id));
  assert.equal(evidenceExport.annotations[0]?.sourceText, block.sourceText);
  assert.equal(section.documentId, document.id);

  const fresh = await PdfWorkspace.open(join(root, "fresh-library"));
  try {
    const freshDocument = await fresh.importPdf(pdfPath);
    await fresh.inspectPage(freshDocument.id, block.pageNumber);
    const freshBlock = fresh.listBlocks(freshDocument.id).find(({ id }) => id === block.id)!;
    const resolution = resolveEvidenceAnchor(evidenceExport.annotations[0]!.evidence, {
      documentHash: freshDocument.documentHash,
      page: freshBlock.pageNumber,
      blockId: freshBlock.id,
      extractionRevision: freshBlock.extractionRevision,
      content: freshBlock.sourceText,
      pageImageHash: fresh.evidenceForBlock(freshBlock.id).pageImageHash,
    });
    assert.equal(resolution.status, "current");
  } finally {
    fresh.close();
  }
});
