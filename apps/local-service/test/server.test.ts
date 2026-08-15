import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PDFDocument, StandardFonts } from "pdf-lib";

import type { VoiceProvider } from "@scribe-skill/audio";

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

  const section = await fetch(`${service.url}/api/documents/${result.document.id}/sections`, {
    headers: { origin, "x-scribe-token": token },
  }).then((response) => response.json()) as Array<{ id: string }>;
  const unavailable = await fetch(`${service.url}/api/audio/jobs`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-scribe-token": token },
    body: JSON.stringify({ sectionId: section[0]!.id, provider: "openai", voice: "coral" }),
  });
  assert.equal(unavailable.status, 409);
  assert.match((await unavailable.json() as { error: string }).error, /key is not configured/);
});

test("builds cited section scripts and caches a provider artifact without a real API key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-narration-service-"));
  const pdfPath = join(root, "narration.pdf");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600, 800]);
  page.drawText("A narrated sentence with exact evidence.", { x: 50, y: 720, size: 12, font });
  await writeFile(pdfPath, await pdf.save());
  const fakeOpenAi: VoiceProvider = {
    capability: () => ({ provider: "openai", available: true, requiresApiKey: true, timingQuality: "none", streaming: false }),
    synthesize: async () => ({
      mimeType: "audio/mpeg",
      bytes: Uint8Array.from([73, 68, 51, 3]),
      timingQuality: "none",
      timings: [],
      disclosure: "This test artifact uses a synthetic voice.",
    }),
  };
  const token = "narration-token";
  const service = await startLocalService({
    token,
    workspacePath: join(root, "library"),
    createProviderRegistry: async () => ({ openai: fakeOpenAi }),
    resolveCodexCapability: async () => ({
      id: "codex-session",
      state: "available",
      executionModes: ["codex-session"],
      checks: { sdkInstalled: true, authenticated: true, smokeTested: true, workspaceAccess: true, networkDisabled: true },
    }),
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const headers = { "content-type": "application/json", "x-scribe-token": token };
  const imported = await fetch(`${service.url}/api/import`, {
    method: "POST", headers, body: JSON.stringify({ path: pdfPath }),
  }).then((response) => response.json()) as { sections: Array<{ id: string }> };
  const sectionId = imported.sections[0]!.id;
  const script = await fetch(`${service.url}/api/sections/${sectionId}/narration-script`, { headers })
    .then((response) => response.json()) as { readingText: string; sourceText: string; evidence: Array<{ blockId: string }> };
  assert.equal(script.readingText, "A narrated sentence with exact evidence.");
  assert.equal(script.sourceText, script.readingText);
  assert.equal(script.evidence.length, 1);
  const savedScriptResponse = await fetch(`${service.url}/api/sections/${sectionId}/narration-script`, {
    method: "POST",
    headers,
    body: JSON.stringify({ readingText: "A publisher-approved cited narration draft.", revision: 2 }),
  });
  assert.equal(savedScriptResponse.status, 201);
  const savedScript = await savedScriptResponse.json() as { id: string; readingText: string; revision: number };
  assert.equal(savedScript.revision, 2);
  const reopenedScript = await fetch(`${service.url}/api/sections/${sectionId}/narration-script`, { headers })
    .then((response) => response.json()) as typeof savedScript;
  assert.equal(reopenedScript.id, savedScript.id);
  assert.equal(reopenedScript.readingText, "A publisher-approved cited narration draft.");

  const capability = await fetch(`${service.url}/api/capabilities`, { headers })
    .then((response) => response.json()) as { voices: Array<{ provider: string; available: boolean }>; codex: { state: string } };
  assert.equal(capability.voices.find(({ provider }) => provider === "openai")?.available, true);
  assert.equal(capability.codex.state, "available");

  const invalidRevision = await fetch(`${service.url}/api/audio/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sectionId, provider: "openai", voice: "coral", revision: "2" }),
  });
  assert.equal(invalidRevision.status, 400);

  const queuedResponse = await fetch(`${service.url}/api/audio/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sectionId, provider: "openai", voice: "coral", readingText: savedScript.readingText, revision: 2 }),
  });
  assert.equal(queuedResponse.status, 202);
  let job = await queuedResponse.json() as { id: string; status: string; artifact?: { disclosure: string } };
  for (let attempt = 0; attempt < 20 && job.status !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = await fetch(`${service.url}/api/audio/jobs/${job.id}`, { headers }).then((response) => response.json()) as typeof job;
  }
  assert.equal(job.status, "completed");
  assert.match(job.artifact?.disclosure ?? "", /synthetic voice/);
  const artifact = new Uint8Array(await fetch(`${service.url}/api/audio/jobs/${job.id}/artifact`, { headers }).then((response) => response.arrayBuffer()));
  assert.deepEqual(artifact, Uint8Array.from([73, 68, 51, 3]));

  const cached = await fetch(`${service.url}/api/audio/jobs`, {
    method: "POST", headers, body: JSON.stringify({ sectionId, provider: "openai", voice: "coral", readingText: savedScript.readingText, revision: 2 }),
  }).then((response) => response.json()) as { id: string; status: string };
  assert.equal(cached.id, job.id);
  assert.equal(cached.status, "completed");
  const boundedJobs = await fetch(`${service.url}/api/audio/jobs?limit=1`, { headers }).then((response) => response.json()) as unknown[];
  assert.equal(boundedJobs.length, 1);
  assert.equal((await fetch(`${service.url}/api/audio/jobs?limit=0`, { headers })).status, 400);
});
