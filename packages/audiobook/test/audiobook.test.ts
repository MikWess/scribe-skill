import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AudioWorkspace, createNarrationScript, type VoiceProvider } from "@scribe-skill/audio";
import { sha256, type EvidenceAnchor } from "@scribe-skill/core";

import { AudiobookWorkspace, createAudiobookPlan, splitNarrationText } from "../src/index.ts";
import type { CreateAudiobookPlanInput } from "../src/index.ts";

function evidenceFor(text: string): EvidenceAnchor[] {
  return [{
    id: "ev-1",
    documentHash: `sha256:${"1".repeat(64)}`,
    extractionRevision: 1,
    page: 1,
    blockId: "block-1",
    characterRange: { start: 0, end: text.length },
    contentHash: sha256(text),
  }];
}

function fakeMp3(marker = 0): Uint8Array {
  const bytes = new Uint8Array(417);
  bytes.set([0xff, 0xfb, 0x90, 0x64, marker]);
  return bytes;
}

function planInput(readingText = "First sentence for a cited chapter. Second sentence for a resumable production run."): CreateAudiobookPlanInput {
  return {
    documentId: "doc-1",
    documentHash: `sha256:${"1".repeat(64)}`,
    extractionRevision: 1,
    sections: [{
      sectionId: "section-1",
      title: "Opening",
      startPage: 1,
      endPage: 2,
      quality: "good",
      qualityApproved: false,
      script: createNarrationScript("section-1", readingText, readingText, evidenceFor(readingText), 1),
    }],
    provider: "openai",
    providerHost: "api.openai.com",
    voice: "coral",
    format: "mp3",
    timingQuality: "none",
    maxChunkCharacters: 48,
    pricing: {
      kind: "user-supplied-per-million-characters",
      usdPerMillionCharacters: 20,
      checkedAt: "2026-08-15T00:00:00.000Z",
      note: "Operator planning rate",
    },
    budget: { maxCostUsd: 1, maxCharacters: 10_000, maxProviderRequests: 20 },
    rights: {
      affirmed: true,
      scope: "private-listening",
      attestor: "user",
      statementVersion: "2026-08-15",
      affirmedAt: "2026-08-15T00:00:00.000Z",
    },
    pronunciation: [],
  };
}

test("planner creates deterministic bounded cited chunks and explicit blockers", () => {
  const chunks = splitNarrationText("One complete sentence. Two complete sentences. Three.", 32);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(({ text }) => text.length <= 32));
  assert.equal(chunks.map(({ text }) => text).join(" "), "One complete sentence. Two complete sentences. Three.");

  const input = planInput();
  const first = createAudiobookPlan(input, "plan-1");
  const second = createAudiobookPlan(input, "plan-1");
  assert.equal(first.planHash, second.planHash);
  assert.ok(first.chunks.length > 1);
  assert.ok(first.chunks.every(({ request }) => request.script.evidence[0]?.id.startsWith("ev-1")));
  assert.ok(first.chunks.every(({ evidenceScope }) => evidenceScope === "exact"));
  assert.ok(first.estimatedCostUsd > 0);

  const blocked = createAudiobookPlan({
    ...input,
    rights: { ...input.rights, affirmed: false },
    sections: [{ ...input.sections[0]!, quality: "review-needed", qualityApproved: false }],
    budget: { ...input.budget, maxProviderRequests: 1 },
  }, "blocked");
  assert.deepEqual(new Set(blocked.blockers.map(({ code }) => code)), new Set(["rights-required", "quality-approval-required", "requests"]));

  assert.throws(
    () => createAudiobookPlan({ ...input, sections: [input.sections[0]!, input.sections[0]!] }, "duplicates"),
    /section must be unique/i,
  );

  const pronunciationBlocked = createAudiobookPlan({
    ...input,
    pronunciation: [{ source: "e", spoken: "e".repeat(256) }],
  }, "pronunciation-expansion");
  assert.ok(pronunciationBlocked.blockers.some(({ code, message }) => code === "chunking" && /pronunciation expansion/i.test(message)));
});

test("a replacement plan changes only the edited narration part cache identity", () => {
  const source = "Alpha sentence stays exactly the same. Bravo sentence changes one token here. Charlie sentence also stays exactly the same.";
  const edited = source.replace("token", "wordx");
  const originalInput = planInput(source);
  originalInput.maxChunkCharacters = 45;
  const editedInput: CreateAudiobookPlanInput = {
    ...originalInput,
    sections: [{
      ...originalInput.sections[0]!,
      script: createNarrationScript("section-1", source, edited, evidenceFor(source), 2),
    }],
  };
  const original = createAudiobookPlan(originalInput, "original");
  const replacement = createAudiobookPlan(editedInput, "replacement");
  assert.equal(original.chunks.length, 3);
  assert.equal(replacement.chunks.length, 3);
  assert.equal(original.chunks[0]?.id, replacement.chunks[0]?.id);
  assert.notEqual(original.chunks[1]?.id, replacement.chunks[1]?.id);
  assert.equal(original.chunks[2]?.id, replacement.chunks[2]?.id);
  assert.equal(replacement.chunks[1]?.evidenceScope, "section");
  assert.equal(replacement.chunks[0]?.evidenceScope, "exact");
});

test("production pauses after the active request, resumes without duplicates, requires QC review, and exports checksums", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-audiobook-"));
  const audio = await AudioWorkspace.open(join(root, "audio"));
  const audiobooks = await AudiobookWorkspace.open(join(root, "production"), audio);
  t.after(async () => {
    audiobooks.close();
    await audio.close();
    await rm(root, { recursive: true, force: true });
  });

  let providerCalls = 0;
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let allowFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { allowFirst = resolve; });
  const provider: VoiceProvider = {
    capability: () => ({ provider: "openai", available: true, requiresApiKey: true, timingQuality: "none", streaming: false, maxCharacters: 4096 }),
    synthesize: async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        releaseFirst();
        await firstGate;
      }
      return { mimeType: "audio/mpeg", bytes: fakeMp3(providerCalls), timingQuality: "none", timings: [], disclosure: "Synthetic test voice" };
    },
  };
  const registry = { openai: provider };
  const originalInput = planInput();
  const draft = audiobooks.createPlan(originalInput, "resumable-plan");
  const approved = audiobooks.confirm(draft.id, draft.planHash);
  assert.equal(approved.state, "approved");
  assert.ok(approved.receipt?.evidenceIds.some((id) => id.startsWith("ev-1")));

  const processing = audiobooks.process(draft.id, registry, { validateChunk: () => true });
  await firstStarted;
  assert.equal(audiobooks.pause(draft.id).state, "paused");
  allowFirst();
  const paused = await processing;
  assert.equal(paused.state, "paused");
  assert.equal(paused.chunks.filter(({ state }) => state === "generated").length, 1);

  const generated = await audiobooks.process(draft.id, registry, { validateChunk: () => true });
  assert.equal(generated.state, "needs-review");
  assert.equal(providerCalls, draft.chunks.length);
  assert.ok(generated.chunks.every(({ qc }) => qc.state === "warning"));
  assert.throws(() => audiobooks.approveReview(draft.id, { reviewer: "agent" }), /review reason/i);
  const reviewed = audiobooks.approveReview(draft.id, { reviewer: "agent", reason: "Listened to every short test part; timing is intentionally unavailable." });
  assert.equal(reviewed.state, "completed");
  assert.ok(reviewed.chunks.every(({ qc }) => qc.state === "waived"));

  const exported = await audiobooks.exportPackage(draft.id, { affirmed: true, purpose: "private-backup", attestor: "user" });
  assert.ok(exported.export?.path.startsWith(join(root, "production", "exports")));
  const manifestText = await readFile(join(exported.export!.path, "audiobook.json"), "utf8");
  const manifest = JSON.parse(manifestText) as { chunks: Array<{ artifact: { file: string }; evidenceIds: string[]; evidence: EvidenceAnchor[] }>; rights: { affirmed: boolean }; sourceReview: Array<{ sectionId: string; quality: string; qualityApproved: boolean }> };
  assert.equal(manifest.rights.affirmed, true);
  assert.ok(manifest.chunks.every(({ artifact }) => !artifact.file.startsWith("/")));
  assert.ok(manifest.chunks.every(({ evidenceIds }) => evidenceIds.some((id) => id.startsWith("ev-1"))));
  assert.ok(manifest.chunks.every(({ evidence: anchors }) => anchors.every((anchor) => anchor.page === 1 && anchor.blockId === "block-1" && anchor.contentHash.startsWith("sha256:"))));
  assert.deepEqual(manifest.sourceReview, [{ sectionId: "section-1", title: "Opening", pages: [1, 2], quality: "good", qualityApproved: false }]);
  const sums = await readFile(join(exported.export!.path, "SHA256SUMS"), "utf8");
  assert.match(sums, /audiobook\.json/);
  assert.match(sums, /chapters\//);

  const editedReading = originalInput.sections[0]!.script.readingText.replace("Second", "Edited");
  const replacementInput: CreateAudiobookPlanInput = {
    ...originalInput,
    sections: [{
      ...originalInput.sections[0]!,
      script: createNarrationScript("section-1", originalInput.sections[0]!.script.sourceText, editedReading, evidenceFor(originalInput.sections[0]!.script.sourceText), 2),
    }],
  };
  const replacement = audiobooks.createPlan(replacementInput, "replacement-plan");
  audiobooks.confirm(replacement.id, replacement.planHash);
  const callsBeforeReplacement = providerCalls;
  const replacementRun = await audiobooks.process(replacement.id, registry, { validateChunk: () => true });
  assert.equal(replacementRun.state, "needs-review");
  assert.equal(providerCalls, callsBeforeReplacement + 1);
  assert.equal(replacementRun.chunks.filter(({ reused }) => reused).length, replacementRun.chunks.length - 1);

  const invalidInput = { ...originalInput, voice: "invalid-audio" };
  const invalid = audiobooks.createPlan(invalidInput, "invalid-audio-plan");
  audiobooks.confirm(invalid.id, invalid.planHash);
  const invalidResult = await audiobooks.process(invalid.id, { openai: {
    ...provider,
    synthesize: async () => ({ mimeType: "audio/mpeg", bytes: Uint8Array.from([73, 68, 51, 1]), timingQuality: "none", timings: [], disclosure: "Invalid test bytes" }),
  } }, { validateChunk: () => true });
  assert.equal(invalidResult.state, "failed");
  assert.equal(invalidResult.chunks[0]?.state, "failed");
  assert.ok(invalidResult.chunks[0]?.qc.checks.some(({ code }) => code === "audio-invalid"));
  const invalidRetry = await audiobooks.retryChunk(invalid.id, invalidResult.chunks[0]!.id);
  assert.equal(invalidRetry.state, "paused");
  assert.equal(invalidRetry.chunks[0]?.state, "planned");
  const recoveredInvalid = await audiobooks.process(invalid.id, registry, { validateChunk: () => true });
  assert.equal(recoveredInvalid.state, "needs-review");
  assert.equal(recoveredInvalid.chunks[0]?.priorArtifacts?.length, 1);
  assert.equal(recoveredInvalid.chunks[0]?.priorArtifacts?.[0]?.qc.state, "failed");
  assert.equal(recoveredInvalid.chunks[0]?.dispatches, 2);

  const firstExportPath = exported.export!.path;
  const artifact = reviewed.chunks[0]!.artifact!;
  await writeFile(join(root, "audio", "artifacts", `${artifact.contentHash.slice("sha256:".length)}.mp3`), Uint8Array.from([0]));
  await assert.rejects(
    audiobooks.exportPackage(draft.id, { affirmed: true, purpose: "private-backup", attestor: "user" }),
    /integrity check/i,
  );
  assert.ok((await readFile(join(firstExportPath, "audiobook.json"), "utf8")).includes(draft.planHash));
});

test("a crash before provider claim reuses the reserved request and does not double-charge", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-audiobook-reservation-"));
  const audio = await AudioWorkspace.open(join(root, "audio"));
  const audiobooks = await AudiobookWorkspace.open(join(root, "production"), audio);
  t.after(async () => {
    audiobooks.close();
    await audio.close();
    await rm(root, { recursive: true, force: true });
  });
  let calls = 0;
  const provider: VoiceProvider = {
    capability: () => ({ provider: "openai", available: true, requiresApiKey: true, timingQuality: "none", streaming: false }),
    synthesize: async () => {
      calls += 1;
      return { mimeType: "audio/mpeg", bytes: fakeMp3(calls), timingQuality: "none", timings: [], disclosure: "Reservation test" };
    },
  };
  const input = planInput("One short reservation test chapter.");
  const draft = audiobooks.createPlan(input, "reservation-plan");
  audiobooks.confirm(draft.id, draft.planHash);
  let injected = false;
  const failed = await audiobooks.process(draft.id, { openai: provider }, {
    validateChunk: () => true,
    afterDispatchReserved: () => {
      if (!injected) {
        injected = true;
        throw new Error("Injected crash before claim");
      }
    },
  });
  assert.equal(failed.state, "failed");
  assert.equal(failed.providerRequests, 1);
  assert.equal(calls, 0);
  await audiobooks.retryChunk(draft.id, failed.chunks[0]!.id);
  const resumed = await audiobooks.process(draft.id, { openai: provider }, { validateChunk: () => true });
  assert.equal(resumed.state, "needs-review");
  assert.equal(resumed.providerRequests, 1);
  assert.equal(resumed.committedCostUsd, failed.committedCostUsd);
  assert.equal(calls, 1);
});

test("source drift stops before provider egress", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-audiobook-drift-"));
  const audio = await AudioWorkspace.open(join(root, "audio"));
  const audiobooks = await AudiobookWorkspace.open(join(root, "production"), audio);
  t.after(async () => {
    audiobooks.close();
    await audio.close();
    await rm(root, { recursive: true, force: true });
  });
  let calls = 0;
  const provider: VoiceProvider = {
    capability: () => ({ provider: "openai", available: true, requiresApiKey: true, timingQuality: "none", streaming: false }),
    synthesize: async () => {
      calls += 1;
      return { mimeType: "audio/mpeg", bytes: Uint8Array.from([1]), timingQuality: "none", timings: [], disclosure: "test" };
    },
  };
  const draft = audiobooks.createPlan({ ...planInput(), voice: "alloy" }, "drift-plan");
  audiobooks.confirm(draft.id, draft.planHash);
  const stopped = await audiobooks.process(draft.id, { openai: provider }, { validateChunk: () => false });
  assert.equal(stopped.state, "stale");
  assert.equal(stopped.chunks[0]?.state, "stale");
  assert.equal(calls, 0);
});
