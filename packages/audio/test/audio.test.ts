import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  AudioWorkspace,
  ElevenLabsVoiceProvider,
  OpenAiVoiceProvider,
  createNarrationScript,
  narrationCacheKey,
} from "@scribe-skill/audio";
import type { VoiceProvider } from "@scribe-skill/audio";
import type { EvidenceAnchor } from "@scribe-skill/core";

const anchor: EvidenceAnchor = {
  id: "anchor-test", documentHash: "sha256:book", page: 1, blockId: "block-1",
  characterRange: { start: 0, end: 12 }, extractionRevision: 1, contentHash: "sha256:text",
};

test("script revisions produce deterministic, distinct cache identities", () => {
  const first = createNarrationScript("section-1", "Source text.", "Reading text.", [anchor], 1);
  const same = createNarrationScript("section-1", "Source text.", "Reading text.", [anchor], 1);
  const revised = createNarrationScript("section-1", "Source text.", "Reading text revised.", [anchor], 2);
  assert.equal(first.id, same.id);
  assert.notEqual(first.id, revised.id);
  assert.equal(narrationCacheKey({ script: first, provider: "openai", voice: "coral", format: "mp3" }), narrationCacheKey({ script: same, provider: "openai", voice: "coral", format: "mp3" }));
  const movedEvidence = createNarrationScript("section-1", "Source text.", "Reading text.", [{ ...anchor, page: 2 }], 1);
  assert.notEqual(first.id, movedEvidence.id);
  assert.notEqual(
    narrationCacheKey({ script: first, provider: "openai", voice: "coral", format: "mp3" }),
    narrationCacheKey({ script: movedEvidence, provider: "openai", voice: "coral", format: "mp3" }),
  );
});

test("providers disclose unavailable credentials without attempting egress", async () => {
  const forbiddenFetch = async () => { throw new Error("network should not be called"); };
  const openai = new OpenAiVoiceProvider(undefined, forbiddenFetch as typeof fetch);
  const elevenlabs = new ElevenLabsVoiceProvider(undefined, forbiddenFetch as typeof fetch);
  assert.equal(openai.capability().available, false);
  assert.equal(elevenlabs.capability().available, false);
  const script = createNarrationScript("section-1", "Source text.", "Reading text.", [anchor]);
  await assert.rejects(() => openai.synthesize({ script, provider: "openai", voice: "coral", format: "mp3" }), /OpenAI API key/);
});

test("OpenAI sends the documented speech request and does not claim timestamps", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
  };
  const provider = new OpenAiVoiceProvider("test-key", fetcher as typeof fetch);
  const script = createNarrationScript("section-1", "Source text.", "Reading text.", [anchor]);
  const artifact = await provider.synthesize({ script, provider: "openai", voice: "coral", format: "mp3", instructions: "Calmly" });
  assert.equal(requests[0]?.url, "https://api.openai.com/v1/audio/speech");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    model: "gpt-4o-mini-tts", voice: "coral", input: "Reading text.", instructions: "Calmly", response_format: "mp3",
  });
  assert.equal(artifact.timingQuality, "none");
  assert.match(artifact.disclosure, /AI-generated voice/);
});

test("OpenAI rejects a successful response without usable audio", async () => {
  const provider = new OpenAiVoiceProvider("test-key", (async () =>
    new Response(new Uint8Array(), { status: 200, headers: { "content-type": "audio/mpeg" } })) as typeof fetch);
  const script = createNarrationScript("section-1", "Source text.", "Reading text.", [anchor]);
  await assert.rejects(
    () => provider.synthesize({ script, provider: "openai", voice: "coral", format: "mp3" }),
    /empty audio artifact/,
  );
});

test("OpenAI rejects oversized sections before provider egress", async () => {
  let calls = 0;
  const provider = new OpenAiVoiceProvider("test-key", (async () => { calls += 1; return new Response(); }) as typeof fetch);
  const script = createNarrationScript("section-1", "Source text.", "x".repeat(4097), [anchor]);
  await assert.rejects(
    () => provider.synthesize({ script, provider: "openai", voice: "coral", format: "mp3" }),
    /4,096 character limit/,
  );
  assert.equal(calls, 0);
});

test("ElevenLabs converts character alignment into exact local spans", async () => {
  const fetcher = async () => new Response(JSON.stringify({
    audio_base64: Buffer.from([4, 5, 6]).toString("base64"),
    alignment: {
      characters: ["H", "i"],
      character_start_times_seconds: [0, 0.1],
      character_end_times_seconds: [0.1, 0.2],
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const provider = new ElevenLabsVoiceProvider("test-key", fetcher as typeof fetch);
  const script = createNarrationScript("section-1", "Hi", "Hi", [anchor]);
  const artifact = await provider.synthesize({ script, provider: "elevenlabs", voice: "voice-id", format: "mp3" });
  assert.equal(artifact.timingQuality, "exact-character");
  assert.deepEqual(artifact.timings[1], {
    text: "i", startSeconds: 0.1, endSeconds: 0.2, characterRange: { start: 1, end: 2 },
  });
});

test("ElevenLabs rejects invalid audio and downgrades untrustworthy alignment", async () => {
  const script = createNarrationScript("section-1", "Hi", "Hi", [anchor]);
  const invalidAudio = new ElevenLabsVoiceProvider("test-key", (async () =>
    new Response(JSON.stringify({ audio_base64: "%%%" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch);
  await assert.rejects(
    () => invalidAudio.synthesize({ script, provider: "elevenlabs", voice: "voice-id", format: "mp3" }),
    /invalid base64/,
  );
  const badAlignment = new ElevenLabsVoiceProvider("test-key", (async () => new Response(JSON.stringify({
    audio_base64: Buffer.from([4, 5, 6]).toString("base64"),
    alignment: {
      characters: ["H", "x"],
      character_start_times_seconds: [0, -1],
      character_end_times_seconds: [0.1, 0.2],
    },
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch);
  const artifact = await badAlignment.synthesize({ script, provider: "elevenlabs", voice: "voice-id", format: "mp3" });
  assert.equal(artifact.timingQuality, "none");
  assert.deepEqual(artifact.timings, []);
});

test("ElevenLabs timing ranges use UTF-16 offsets expected by browser text", async () => {
  const script = createNarrationScript("section-1", "A😀B", "A😀B", [anchor]);
  const provider = new ElevenLabsVoiceProvider("test-key", (async () => new Response(JSON.stringify({
    audio_base64: Buffer.from([4, 5, 6]).toString("base64"),
    alignment: {
      characters: ["A", "😀", "B"],
      character_start_times_seconds: [0, 0.1, 0.2],
      character_end_times_seconds: [0.1, 0.2, 0.3],
    },
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch);
  const artifact = await provider.synthesize({ script, provider: "elevenlabs", voice: "voice-id", format: "mp3" });
  assert.deepEqual(artifact.timings.map(({ characterRange }) => characterRange), [
    { start: 0, end: 1 }, { start: 1, end: 3 }, { start: 3, end: 4 },
  ]);
});

test("persistent queue is idempotent, integrity checked, and reusable after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-audio-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = createNarrationScript("section-1", "Source text.", "Reading text.", [anchor]);
  const request = { script, provider: "openai" as const, voice: "coral", format: "mp3" as const };
  const fakeProvider: VoiceProvider = {
    capability: () => ({ provider: "openai", available: true, requiresApiKey: true, timingQuality: "none", streaming: false }),
    synthesize: async () => ({
      mimeType: "audio/mpeg", bytes: Uint8Array.from([7, 8, 9]), timingQuality: "none", timings: [], disclosure: "Synthetic test voice",
    }),
  };

  const first = await AudioWorkspace.open(root);
  first.saveScript(script);
  assert.equal(first.latestScript(script.sectionId)?.id, script.id);
  assert.throws(
    () => first.saveScript(createNarrationScript("section-1", "Source text.", "Conflicting reading.", [anchor], 1)),
    /revision must be greater than 1/,
  );
  const queued = first.enqueue(request);
  assert.equal(first.enqueue(request).id, queued.id);
  const completed = await first.processNext({ openai: fakeProvider });
  assert.equal(completed?.status, "completed");
  assert.deepEqual(await first.readArtifact(queued.id), Uint8Array.from([7, 8, 9]));
  await first.close();

  const reopened = await AudioWorkspace.open(root);
  assert.equal(reopened.get(queued.id)?.status, "completed");
  assert.equal(reopened.enqueue(request).attempts, 1);
  await reopened.close();
});

test("a partial v1 narration migration recovers idempotently", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-audio-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = new DatabaseSync(join(root, "audio.sqlite"));
  database.exec(`
    CREATE TABLE audio_jobs (status TEXT, error TEXT, updated_at TEXT);
    CREATE TABLE narration_scripts (
      id TEXT PRIMARY KEY,
      section_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      script_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    PRAGMA user_version = 1;
  `);
  database.close();

  const recovered = await AudioWorkspace.open(root);
  await recovered.close();
  const inspected = new DatabaseSync(join(root, "audio.sqlite"));
  assert.equal(Number(inspected.prepare("PRAGMA user_version").get()?.user_version), 2);
  inspected.close();
});

test("queue exposes failures, cancellation, and deliberate retry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-audio-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await AudioWorkspace.open(root);
  t.after(() => workspace.close());
  const script = createNarrationScript("section-1", "Source text.", "Reading text.", [anchor]);
  const failed = workspace.enqueue({ script, provider: "openai", voice: "coral", format: "mp3" });
  assert.equal((await workspace.processNext({}))?.status, "failed");
  assert.match(workspace.get(failed.id)?.error ?? "", /not configured/);
  assert.equal(workspace.retry(failed.id).status, "queued");
  assert.equal(workspace.cancel(failed.id).status, "cancelled");
});

test("cancelling a running job aborts the provider and never commits an artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-audio-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await AudioWorkspace.open(root);
  t.after(() => workspace.close());
  const script = createNarrationScript("section-1", "Source text.", "Reading text.", [anchor]);
  const queued = workspace.enqueue({ script, provider: "openai", voice: "coral", format: "mp3" });
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let observedAbort = false;
  const provider: VoiceProvider = {
    capability: () => ({ provider: "openai", available: true, requiresApiKey: true, timingQuality: "none", streaming: true }),
    synthesize: async (_request, signal) => {
      markStarted?.();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          observedAbort = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    },
  };
  const processing = workspace.processNext({ openai: provider });
  await started;
  assert.equal(workspace.cancel(queued.id).status, "cancelled");
  assert.equal((await processing)?.status, "cancelled");
  assert.equal(observedAbort, true);
  await assert.rejects(() => workspace.readArtifact(queued.id), /not ready/);
});

test("closing during synthesis aborts cleanly before the database closes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scribe-skill-audio-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await AudioWorkspace.open(root);
  const script = createNarrationScript("section-1", "Source text.", "Reading text.", [anchor]);
  workspace.enqueue({ script, provider: "openai", voice: "coral", format: "mp3" });
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const provider: VoiceProvider = {
    capability: () => ({ provider: "openai", available: true, requiresApiKey: true, timingQuality: "none", streaming: true }),
    synthesize: async (_request, signal) => {
      markStarted?.();
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  };
  const processing = workspace.processNext({ openai: provider });
  await started;
  await workspace.close();
  assert.equal((await processing)?.status, "running");
});
