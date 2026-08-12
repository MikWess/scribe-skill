import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PDFDocument, StandardFonts } from "pdf-lib";

import { startLocalService } from "../src/server.ts";

test("serves a token-protected, cited reader workflow over loopback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-service-"));
  const pdfPath = join(root, "reader.pdf");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600, 800]);
  page.drawText("Evidence stays attached to its source.", { x: 50, y: 720, size: 12, font });
  await writeFile(pdfPath, await pdf.save());
  const token = "test-token";
  const origin = "http://localhost:5173";
  const service = await startLocalService({
    token,
    workspacePath: join(root, "library"),
    allowedOrigins: [origin],
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  const unauthorized = await fetch(`${service.url}/api/health`);
  assert.equal(unauthorized.status, 401);
  const forbiddenOrigin = await fetch(`${service.url}/api/health`, {
    headers: { origin: "https://untrusted.example", "x-scribe-token": token },
  });
  assert.equal(forbiddenOrigin.status, 403);

  const imported = await fetch(`${service.url}/api/import-file?name=reader.pdf`, {
    method: "POST",
    headers: { origin, "content-type": "application/pdf", "x-scribe-token": token },
    body: await readFile(pdfPath),
  });
  assert.equal(imported.status, 201);
  const result = await imported.json() as { document: { id: string; documentHash: string } };
  const inspection = await fetch(`${service.url}/api/documents/${result.document.id}/pages/1`, {
    headers: { origin, "x-scribe-token": token },
  }).then((response) => response.json()) as { blocks: Array<{ id: string; sourceText: string }> };
  assert.equal(inspection.blocks[0]?.sourceText, "Evidence stays attached to its source.");

  const noteResponse = await fetch(`${service.url}/api/documents/${result.document.id}/annotations`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-scribe-token": token },
    body: JSON.stringify({
      blockId: inspection.blocks[0]!.id,
      kind: "note",
      authorship: "user",
      content: "A portable cited note.",
    }),
  });
  assert.equal(noteResponse.status, 201);
  const exported = await fetch(`${service.url}/api/documents/${result.document.id}/annotations.evidence.json`, {
    headers: { origin, "x-scribe-token": token },
  }).then((response) => response.json()) as {
    documentHash: string;
    annotations: Array<{ sourceText: string; evidence: { blockId: string; documentHash: string } }>;
  };
  assert.equal(exported.documentHash, result.document.documentHash);
  assert.equal(exported.annotations[0]?.sourceText, "Evidence stays attached to its source.");
  assert.equal(exported.annotations[0]?.evidence.blockId, inspection.blocks[0]!.id);
  assert.equal(exported.annotations[0]?.evidence.documentHash, result.document.documentHash);
});
