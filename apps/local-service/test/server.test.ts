import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PDFDocument, StandardFonts } from "pdf-lib";

import type { VoiceProvider } from "@scribe-skill/audio";

import { startLocalService } from "../src/server.ts";

function fakeMp3(marker = 0): Uint8Array {
  const bytes = new Uint8Array(417);
  bytes.set([0xff, 0xfb, 0x90, 0x64, marker]);
  return bytes;
}

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
  }).then((response) => response.json()) as Array<{ id: string; status: string }>;
  assert.equal(section[0]?.status, "proposed");
  const corpus = await fetch(`${service.url}/api/documents/${result.document.id}/corpus`, {
    headers: { origin, "x-scribe-token": token },
  }).then((response) => response.json()) as { summary: { passageCount: number; structureRevision: number } };
  assert.equal(corpus.summary.passageCount, 1);
  const passagePage = await fetch(`${service.url}/api/documents/${result.document.id}/passages?limit=1&offset=0`, {
    headers: { origin, "x-scribe-token": token },
  }).then((response) => response.json()) as { items: Array<{ evidence: unknown[] }>; nextOffset?: number };
  assert.equal(passagePage.items[0]?.evidence.length, 1);
  const identityInjection = await fetch(`${service.url}/api/sections/${section[0]!.id}`, {
    method: "PATCH",
    headers: { origin, "content-type": "application/json", "x-scribe-token": token },
    body: JSON.stringify({ documentId: "another-book", expectedCorpusRevision: corpus.summary.structureRevision }),
  });
  assert.equal(identityInjection.status, 400);
  const accepted = await fetch(`${service.url}/api/sections/${section[0]!.id}`, {
    method: "PATCH",
    headers: { origin, "content-type": "application/json", "x-scribe-token": token },
    body: JSON.stringify({
      status: "accepted",
      title: "Evidence foundation",
      expectedCorpusRevision: corpus.summary.structureRevision,
    }),
  }).then((response) => response.json()) as { status: string; origin: string; title: string };
  assert.deepEqual(
    { status: accepted.status, origin: accepted.origin, title: accepted.title },
    { status: "accepted", origin: "user", title: "Evidence foundation" },
  );
  const searchResponse = await fetch(`${service.url}/api/search/query`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-scribe-token": token },
    body: JSON.stringify({
      documentId: result.document.id,
      query: "evidence source",
      sourceRevision: {
        documentHash: result.document.documentHash,
        corpusRevision: corpus.summary.structureRevision + 1,
        extractionRevision: 1,
      },
      limit: 5,
      contextBudget: { maxCharacters: 2_000 },
    }),
  });
  assert.equal(searchResponse.status, 200);
  const search = await searchResponse.json() as { schemaVersion: string; results: Array<{ evidence: Array<{ blockId: string }> }> };
  assert.equal(search.schemaVersion, "1");
  assert.equal(search.results[0]?.evidence[0]?.blockId, inspection.blocks[0]!.id);
  const staleMutation = await fetch(`${service.url}/api/sections/${section[0]!.id}`, {
    method: "PATCH",
    headers: { origin, "content-type": "application/json", "x-scribe-token": token },
    body: JSON.stringify({ title: "Lost update", expectedCorpusRevision: corpus.summary.structureRevision }),
  });
  assert.equal(staleMutation.status, 409);
  const conflict = await staleMutation.json() as { current: { structureRevision: number } };
  assert.equal(conflict.current.structureRevision, corpus.summary.structureRevision + 1);
  const unavailable = await fetch(`${service.url}/api/audio/jobs`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-scribe-token": token },
    body: JSON.stringify({ sectionId: section[0]!.id, provider: "openai", voice: "coral" }),
  });
  assert.equal(unavailable.status, 409);
  assert.match((await unavailable.json() as { error: string }).error, /key is not configured/);
});

test("rejects corpus, section, and passage reads after source-asset tampering", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-service-integrity-"));
  const pdfPath = join(root, "integrity.pdf");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([600, 800]).drawText("Cited corpus integrity.", { x: 50, y: 720, size: 12, font });
  await writeFile(pdfPath, await pdf.save());
  const token = "integrity-token";
  const service = await startLocalService({ token, workspacePath: join(root, "library") });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const headers = { "content-type": "application/json", "x-scribe-token": token };
  const imported = await fetch(`${service.url}/api/import`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path: pdfPath }),
  }).then((response) => response.json()) as {
    document: { id: string; assetPath: string };
    sections: Array<{ id: string }>;
  };
  await writeFile(imported.document.assetPath, "tampered");

  for (const path of ["corpus", "sections", "passages"]) {
    const response = await fetch(`${service.url}/api/documents/${imported.document.id}/${path}`, { headers });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /hash does not match/i);
  }
  const narration = await fetch(`${service.url}/api/sections/${imported.sections[0]!.id}/narration-script`, { headers });
  assert.equal(narration.status, 400);
  assert.match((await narration.json() as { error: string }).error, /hash does not match/i);
  const search = await fetch(`${service.url}/api/search/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      documentId: imported.document.id,
      query: "integrity",
      sourceRevision: { corpusRevision: 1 },
      contextBudget: { maxCharacters: 1_000 },
    }),
  });
  assert.equal(search.status, 400);
  assert.match((await search.json() as { error: string }).error, /hash does not match/i);
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
  }).then((response) => response.json()) as {
    sections: Array<{ id: string }>;
    summary: { structureRevision: number };
  };
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

  const proposedGeneration = await fetch(`${service.url}/api/audio/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sectionId, provider: "openai", voice: "coral", revision: 2 }),
  });
  assert.equal(proposedGeneration.status, 422);
  assert.match((await proposedGeneration.json() as { error: string }).error, /accept this section boundary/i);
  const accepted = await fetch(`${service.url}/api/sections/${sectionId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "accepted", expectedCorpusRevision: imported.summary.structureRevision }),
  });
  assert.equal(accepted.status, 200);

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

test("plans and exports a rights- and budget-gated audiobook through the agent API", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-audiobook-service-"));
  const pdfPath = join(root, "book.pdf");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600, 800]);
  page.drawText("A sufficiently long cited chapter becomes a reviewable audiobook package for an agent.", { x: 50, y: 720, size: 12, font });
  await writeFile(pdfPath, await pdf.save());
  let providerCalls = 0;
  const fakeOpenAi: VoiceProvider = {
    capability: () => ({ provider: "openai", available: true, requiresApiKey: true, timingQuality: "none", streaming: false, maxCharacters: 4096 }),
    synthesize: async () => {
      providerCalls += 1;
      return {
        mimeType: "audio/mpeg",
        bytes: fakeMp3(providerCalls),
        timingQuality: "none",
        timings: [],
        disclosure: "Synthetic API test voice",
      };
    },
  };
  const token = "audiobook-token";
  const service = await startLocalService({
    token,
    workspacePath: join(root, "library"),
    createProviderRegistry: async () => ({ openai: fakeOpenAi }),
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const headers = { "content-type": "application/json", "x-scribe-token": token };
  const imported = await fetch(`${service.url}/api/import`, {
    method: "POST", headers, body: JSON.stringify({ path: pdfPath }),
  }).then((response) => response.json()) as {
    document: { id: string; assetPath: string };
    sections: Array<{ id: string }>;
    summary: { structureRevision: number };
  };

  const noIdempotency = await fetch(`${service.url}/api/audiobooks/plans`, {
    method: "POST", headers, body: JSON.stringify({ documentId: imported.document.id }),
  });
  assert.equal(noIdempotency.status, 400);
  const planBody = JSON.stringify({
    documentId: imported.document.id,
    sectionIds: [imported.sections[0]!.id],
    provider: "openai",
    voice: "coral",
    maxChunkCharacters: 64,
    usdPerMillionCharacters: 20,
    maxCostUsd: 1,
    maxCharacters: 10_000,
    maxProviderRequests: 10,
    rightsAffirmed: true,
  });
  const proposedPlan = await fetch(`${service.url}/api/audiobooks/plans`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "proposed-boundary-plan" },
    body: planBody,
  });
  assert.equal(proposedPlan.status, 422);
  assert.match((await proposedPlan.json() as { error: string }).error, /accept every selected section/i);
  const acceptedSection = await fetch(`${service.url}/api/sections/${imported.sections[0]!.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "accepted", expectedCorpusRevision: imported.summary.structureRevision }),
  });
  assert.equal(acceptedSection.status, 200);
  const duplicateSections = await fetch(`${service.url}/api/audiobooks/plans`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "duplicate-sections" },
    body: JSON.stringify({ ...JSON.parse(planBody), sectionIds: [imported.sections[0]!.id, imported.sections[0]!.id] }),
  });
  assert.equal(duplicateSections.status, 400);
  const planResponse = await fetch(`${service.url}/api/audiobooks/plans`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "api-audiobook-plan" },
    body: planBody,
  });
  assert.equal(planResponse.status, 201);
  let run = await planResponse.json() as { id: string; planHash: string; state: string; blockers: unknown[]; chunks: unknown[]; export?: { path: string } };
  assert.equal(run.state, "draft");
  assert.equal(run.blockers.length, 0);
  assert.ok(run.chunks.length >= 2);
  const replay = await fetch(`${service.url}/api/audiobooks/plans`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "api-audiobook-plan" },
    body: planBody,
  });
  assert.equal(replay.status, 201);
  assert.equal((await replay.json() as { id: string }).id, run.id);
  assert.equal((await fetch(`${service.url}/api/audiobooks/${run.id}/start`, { method: "POST", headers, body: "{}" })).status, 400);
  run = await fetch(`${service.url}/api/audiobooks/${run.id}/confirm`, {
    method: "POST", headers, body: JSON.stringify({ planHash: run.planHash }),
  }).then((response) => response.json()) as typeof run;
  assert.equal(run.state, "approved");
  const start = await fetch(`${service.url}/api/audiobooks/${run.id}/start`, { method: "POST", headers, body: "{}" });
  assert.equal(start.status, 202);
  for (let attempt = 0; attempt < 50 && run.state !== "needs-review"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    run = await fetch(`${service.url}/api/audiobooks/${run.id}`, { headers }).then((response) => response.json()) as typeof run;
  }
  assert.equal(run.state, "needs-review");
  assert.equal(providerCalls, run.chunks.length);
  run = await fetch(`${service.url}/api/audiobooks/${run.id}/approve`, {
    method: "POST", headers, body: JSON.stringify({ reviewer: "agent", reason: "Verified every deterministic fake-provider part." }),
  }).then((response) => response.json()) as typeof run;
  assert.equal(run.state, "completed");
  const unauthorizedExport = await fetch(`${service.url}/api/audiobooks/${run.id}/export`, { method: "POST", headers, body: "{}" });
  assert.equal(unauthorizedExport.status, 400);
  run = await fetch(`${service.url}/api/audiobooks/${run.id}/export`, { method: "POST", headers, body: JSON.stringify({ exportAffirmed: true, purpose: "private-backup", attestor: "agent" }) })
    .then((response) => response.json()) as typeof run;
  assert.ok(run.export?.path.includes("production/exports"));

  const customScript = await fetch(`${service.url}/api/sections/${imported.sections[0]!.id}/narration-script`, {
    method: "POST",
    headers,
    body: JSON.stringify({ readingText: "A deliberately edited reading copy for the approved section.", revision: 2 }),
  });
  assert.equal(customScript.status, 201);
  let staleRun = await fetch(`${service.url}/api/audiobooks/plans`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "api-source-drift-plan" },
    body: JSON.stringify({
      documentId: imported.document.id,
      sectionIds: [imported.sections[0]!.id],
      provider: "openai",
      voice: "alloy",
      maxChunkCharacters: 64,
      usdPerMillionCharacters: 20,
      maxCostUsd: 1,
      maxCharacters: 10_000,
      maxProviderRequests: 10,
      rightsAffirmed: true,
    }),
  }).then((response) => response.json()) as typeof run;
  staleRun = await fetch(`${service.url}/api/audiobooks/${staleRun.id}/confirm`, {
    method: "POST", headers, body: JSON.stringify({ planHash: staleRun.planHash }),
  }).then((response) => response.json()) as typeof run;
  const callsBeforeDrift = providerCalls;
  const inspection = await fetch(`${service.url}/api/documents/${imported.document.id}/pages/1`, { headers })
    .then((response) => response.json()) as { blocks: Array<{ id: string }> };
  await fetch(`${service.url}/api/blocks/${inspection.blocks[0]!.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      text: "The repaired reading copy changed after approval.",
      note: "Simulate a post-approval reading-copy repair",
      expectedCorpusRevision: imported.summary.structureRevision + 1,
    }),
  });
  const staleStart = await fetch(`${service.url}/api/audiobooks/${staleRun.id}/start`, { method: "POST", headers, body: "{}" });
  assert.equal(staleStart.status, 409);
  assert.equal(providerCalls, callsBeforeDrift);

  let tamperRun = await fetch(`${service.url}/api/audiobooks/plans`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "api-asset-tamper-plan" },
    body: planBody,
  }).then((response) => response.json()) as typeof run;
  tamperRun = await fetch(`${service.url}/api/audiobooks/${tamperRun.id}/confirm`, {
    method: "POST", headers, body: JSON.stringify({ planHash: tamperRun.planHash }),
  }).then((response) => response.json()) as typeof run;
  await writeFile(imported.document.assetPath, "tampered after approval");
  const tamperedStart = await fetch(`${service.url}/api/audiobooks/${tamperRun.id}/start`, { method: "POST", headers, body: "{}" });
  assert.equal(tamperedStart.status, 409);
  assert.equal(providerCalls, callsBeforeDrift);
});

test("agent API regenerates one structurally invalid part and resumes without repeating completed parts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-audiobook-retry-"));
  const pdfPath = join(root, "retry.pdf");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([600, 800]);
  page.drawText("First cited sentence completes. Second cited sentence fails once. Third cited sentence completes after the deliberate retry.", { x: 40, y: 720, size: 10, font });
  await writeFile(pdfPath, await pdf.save());
  const callsByText = new Map<string, number>();
  let calls = 0;
  const provider: VoiceProvider = {
    capability: () => ({ provider: "openai", available: true, requiresApiKey: true, timingQuality: "none", streaming: false, maxCharacters: 4096 }),
    synthesize: async (narration) => {
      calls += 1;
      callsByText.set(narration.script.readingText, (callsByText.get(narration.script.readingText) ?? 0) + 1);
      return {
        mimeType: "audio/mpeg",
        bytes: calls === 2 ? Uint8Array.from([73, 68, 51, calls]) : fakeMp3(calls),
        timingQuality: "none",
        timings: [],
        disclosure: "Retry test voice",
      };
    },
  };
  const token = "retry-token";
  const service = await startLocalService({ token, workspacePath: join(root, "library"), createProviderRegistry: async () => ({ openai: provider }) });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const headers = { "content-type": "application/json", "x-scribe-token": token };
  const imported = await fetch(`${service.url}/api/import`, { method: "POST", headers, body: JSON.stringify({ path: pdfPath }) })
    .then((response) => response.json()) as {
      document: { id: string };
      sections: Array<{ id: string }>;
      summary: { structureRevision: number };
    };
  const accepted = await fetch(`${service.url}/api/sections/${imported.sections[0]!.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "accepted", expectedCorpusRevision: imported.summary.structureRevision }),
  });
  assert.equal(accepted.status, 200);
  let run = await fetch(`${service.url}/api/audiobooks/plans`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "retry-plan" },
    body: JSON.stringify({ documentId: imported.document.id, sectionIds: [imported.sections[0]!.id], provider: "openai", voice: "coral", maxChunkCharacters: 48, usdPerMillionCharacters: 20, maxCostUsd: 1, maxCharacters: 10_000, maxProviderRequests: 20, rightsAffirmed: true }),
  }).then((response) => response.json()) as { id: string; planHash: string; state: string; chunks: Array<{ id: string; state: string; request: { script: { readingText: string } } }> };
  run = await fetch(`${service.url}/api/audiobooks/${run.id}/confirm`, { method: "POST", headers, body: JSON.stringify({ planHash: run.planHash }) }).then((response) => response.json()) as typeof run;
  await fetch(`${service.url}/api/audiobooks/${run.id}/start`, { method: "POST", headers, body: "{}" });
  for (let attempt = 0; attempt < 50 && run.state !== "failed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    run = await fetch(`${service.url}/api/audiobooks/${run.id}`, { headers }).then((response) => response.json()) as typeof run;
  }
  assert.equal(run.state, "failed");
  const completedText = run.chunks.find(({ state }) => state === "generated")!.request.script.readingText;
  const failedChunk = run.chunks.find(({ state }) => state === "failed")!;
  run = await fetch(`${service.url}/api/audiobooks/${run.id}/chunks/${failedChunk.id}/retry`, { method: "POST", headers, body: "{}" }).then((response) => response.json()) as typeof run;
  assert.equal(run.state, "paused");
  await fetch(`${service.url}/api/audiobooks/${run.id}/resume`, { method: "POST", headers, body: "{}" });
  for (let attempt = 0; attempt < 50 && run.state !== "needs-review"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    run = await fetch(`${service.url}/api/audiobooks/${run.id}`, { headers }).then((response) => response.json()) as typeof run;
  }
  assert.equal(run.state, "needs-review");
  assert.equal(callsByText.get(completedText), 1);
  assert.equal(calls, run.chunks.length + 1);
});
