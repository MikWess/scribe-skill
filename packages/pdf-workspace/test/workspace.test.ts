import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { PdfWorkspace, WorkspaceIntegrityError } from "@scribe-skill/pdf-workspace";

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
