import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AudioWorkspace, type VoiceProviderRegistry } from "@scribe-skill/audio";
import { sha256 } from "@scribe-skill/core";

import type {
  AudiobookRun,
  ChunkQc,
  CreateAudiobookPlanInput,
  ExportedAudiobookManifest,
  ProductionChunk,
} from "./contracts.ts";
import { createAudiobookPlan } from "./planner.ts";

interface RunRow {
  run_json: string;
  request_hash: string;
}

export interface ProcessAudiobookOptions {
  validateChunk?: (chunk: ProductionChunk) => boolean | Promise<boolean>;
  afterDispatchReserved?: (chunk: ProductionChunk) => void | Promise<void>;
}

export interface ReviewInput {
  reviewer: "user" | "agent";
  reason?: string;
}

export interface ExportAuthorization {
  affirmed: boolean;
  purpose: "private-backup" | "redistribution";
  attestor: "user" | "agent";
}

function normalizeRun(row: RunRow): AudiobookRun {
  return JSON.parse(row.run_json) as AudiobookRun;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function mp3FrameLength(bytes: Uint8Array, offset: number): number | undefined {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  if (first !== 0xff || second === undefined || third === undefined || (second & 0xe0) !== 0xe0) return undefined;
  const versionBits = (second >> 3) & 0x03;
  const layerBits = (second >> 1) & 0x03;
  const bitrateIndex = (third >> 4) & 0x0f;
  const sampleIndex = (third >> 2) & 0x03;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return undefined;
  const mpeg1 = versionBits === 3;
  const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
  const mpeg1Rates = layer === 1
    ? [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]
    : layer === 2
      ? [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384]
      : [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const mpeg2Rates = layer === 1
    ? [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]
    : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const bitrate = (mpeg1 ? mpeg1Rates : mpeg2Rates)[bitrateIndex - 1]! * 1000;
  const baseSampleRate = [44_100, 48_000, 32_000][sampleIndex]!;
  const sampleRate = versionBits === 3 ? baseSampleRate : versionBits === 2 ? baseSampleRate / 2 : baseSampleRate / 4;
  const padding = (third >> 1) & 1;
  return layer === 1
    ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
    : Math.floor(((layer === 3 && !mpeg1 ? 72 : 144) * bitrate) / sampleRate + padding);
}

function audioContainerError(bytes: Uint8Array, mimeType: string): string | undefined {
  if (mimeType === "audio/wav") {
    if (bytes.length < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return "Audio bytes are not a structurally valid WAV container";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) + 8 > bytes.length) return "WAV container length exceeds the stored artifact";
    let offset = 12;
    let hasFormat = false;
    let hasAudio = false;
    while (offset + 8 <= bytes.length) {
      const kind = ascii(bytes, offset, 4);
      const size = view.getUint32(offset + 4, true);
      const end = offset + 8 + size;
      if (end > bytes.length) return "WAV chunk length exceeds the stored artifact";
      if (kind === "fmt " && size >= 16) hasFormat = true;
      if (kind === "data" && size > 0) hasAudio = true;
      offset = end + (size % 2);
    }
    return hasFormat && hasAudio ? undefined : "WAV container is missing a format chunk or non-empty audio data";
  }
  if (mimeType === "audio/mpeg") {
    let offset = 0;
    if (bytes.length >= 10 && ascii(bytes, 0, 3) === "ID3") {
      if ([bytes[6], bytes[7], bytes[8], bytes[9]].some((value) => value === undefined || (value & 0x80) !== 0)) return "MP3 ID3 metadata size is invalid";
      offset = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
    }
    const scanEnd = Math.min(bytes.length - 4, offset + 4096);
    for (let candidate = offset; candidate <= scanEnd; candidate += 1) {
      const frameLength = mp3FrameLength(bytes, candidate);
      if (frameLength && candidate + frameLength <= bytes.length) return undefined;
    }
    return "Audio bytes do not contain a complete, structurally valid MP3 frame";
  }
  return `Unsupported audio content type ${mimeType}`;
}

function qcForChunk(chunk: ProductionChunk, bytes: Uint8Array): ChunkQc {
  const artifact = chunk.artifact;
  if (!artifact) return { state: "failed", checks: [{ code: "artifact-missing", severity: "error", message: "No audio artifact was recorded" }] };
  const checks: ChunkQc["checks"] = [];
  if (!artifact.contentHash.startsWith("sha256:")) checks.push({ code: "hash-missing", severity: "error", message: "Artifact has no SHA-256 integrity hash" });
  if (artifact.byteLength < 1) checks.push({ code: "empty-audio", severity: "error", message: "Artifact contains no audio bytes" });
  if (artifact.byteLength !== bytes.byteLength) checks.push({ code: "length-mismatch", severity: "error", message: "Recorded byte length does not match the stored artifact" });
  const containerError = audioContainerError(bytes, artifact.mimeType);
  if (containerError) checks.push({ code: "audio-invalid", severity: "error", message: containerError });
  if (!artifact.disclosure.trim()) checks.push({ code: "disclosure-missing", severity: "error", message: "Provider/timing disclosure is missing" });
  if (artifact.timingQuality === "none") {
    checks.push({ code: "timing-unavailable", severity: "warning", message: "This provider returned audio without synchronization timings" });
  } else {
    let previousEnd = 0;
    for (const timing of artifact.timings) {
      const valid = Number.isFinite(timing.startSeconds)
        && Number.isFinite(timing.endSeconds)
        && timing.startSeconds >= previousEnd
        && timing.endSeconds >= timing.startSeconds
        && timing.characterRange.start >= 0
        && timing.characterRange.end >= timing.characterRange.start
        && timing.characterRange.end <= chunk.request.script.readingText.length;
      if (!valid) {
        checks.push({ code: "timing-invalid", severity: "error", message: "Artifact timing spans are invalid or outside the narration text" });
        break;
      }
      previousEnd = timing.endSeconds;
    }
    if (artifact.timings.length === 0) checks.push({ code: "timing-empty", severity: "warning", message: "Timing was advertised but no timing spans were returned" });
  }
  if (artifact.timingQuality === "estimated-sentence") {
    checks.push({ code: "timing-estimated", severity: "info", message: "Read-along timing is estimated at sentence level" });
  }
  if (!checks.some(({ severity }) => severity === "error")) {
    checks.push({ code: "integrity-recorded", severity: "info", message: "Audio bytes, source revision, evidence IDs, and disclosure are recorded" });
  }
  const state = checks.some(({ severity }) => severity === "error")
    ? "failed"
    : checks.some(({ severity }) => severity === "warning") ? "warning" : "passed";
  return { state, checks };
}

function safeSegment(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "section";
}

function checksumLine(hash: string, path: string): string {
  return `${hash.replace(/^sha256:/, "")}  ${path}`;
}

export class AudiobookWorkspace {
  readonly rootPath: string;
  readonly databasePath: string;
  readonly exportsPath: string;
  private readonly database: DatabaseSync;
  private readonly audio: AudioWorkspace;

  private constructor(rootPath: string, database: DatabaseSync, audio: AudioWorkspace) {
    this.rootPath = rootPath;
    this.databasePath = join(rootPath, "audiobooks.sqlite");
    this.exportsPath = join(rootPath, "exports");
    this.database = database;
    this.audio = audio;
  }

  static async open(rootPath: string, audio: AudioWorkspace): Promise<AudiobookWorkspace> {
    const absoluteRoot = resolve(rootPath);
    await mkdir(join(absoluteRoot, "exports"), { recursive: true });
    const database = new DatabaseSync(join(absoluteRoot, "audiobooks.sqlite"));
    database.exec("PRAGMA journal_mode = WAL; PRAGMA application_id = 1397969730;");
    const workspace = new AudiobookWorkspace(absoluteRoot, database, audio);
    workspace.migrate();
    workspace.recoverInterruptedRuns();
    return workspace;
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > 1) throw new Error(`Audiobook workspace schema ${version} is newer than this app supports`);
    if (version === 0) {
      this.database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE audiobook_runs (
          id TEXT PRIMARY KEY,
          plan_hash TEXT NOT NULL UNIQUE,
          idempotency_key TEXT NOT NULL UNIQUE,
          request_hash TEXT NOT NULL,
          run_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX audiobook_runs_state_updated ON audiobook_runs(updated_at DESC);
        PRAGMA user_version = 1;
        COMMIT;
      `);
    }
  }

  private recoverInterruptedRuns(): void {
    for (const run of this.list(500)) {
      if (run.state !== "running" && !run.chunks.some(({ state }) => state === "running")) continue;
      run.state = "paused";
      for (const chunk of run.chunks) {
        if (chunk.state === "running") {
          chunk.state = "interrupted";
          chunk.error = "Interrupted by application restart; inspect and explicitly retry";
        }
      }
      this.save(run);
    }
  }

  private save(run: AudiobookRun): AudiobookRun {
    const now = new Date().toISOString();
    const next = { ...run, revision: run.revision + 1, updatedAt: now };
    const result = this.database.prepare(
      `UPDATE audiobook_runs SET run_json = ?, revision = ?, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(next), next.revision, now, next.id);
    if (Number(result.changes) !== 1) throw new Error(`Unknown audiobook run: ${run.id}`);
    return next;
  }

  createPlan(input: CreateAudiobookPlanInput, idempotencyKey: string, requestFingerprint?: string): AudiobookRun {
    const proposed = createAudiobookPlan(input, idempotencyKey);
    if (requestFingerprint) proposed.requestHash = requestFingerprint;
    const existing = this.database.prepare("SELECT run_json, request_hash FROM audiobook_runs WHERE idempotency_key = ?").get(idempotencyKey) as RunRow | undefined;
    if (existing) {
      if (existing.request_hash !== proposed.requestHash) throw new Error("Idempotency key was already used for a different audiobook plan");
      return normalizeRun(existing);
    }
    this.database.prepare(
      `INSERT INTO audiobook_runs (id, plan_hash, idempotency_key, request_hash, run_json, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(proposed.id, proposed.planHash, idempotencyKey, proposed.requestHash, JSON.stringify(proposed), proposed.revision, proposed.createdAt, proposed.updatedAt);
    return proposed;
  }

  get(id: string): AudiobookRun | undefined {
    const row = this.database.prepare("SELECT run_json, request_hash FROM audiobook_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? normalizeRun(row) : undefined;
  }

  list(limit = 50): AudiobookRun[] {
    const rows = this.database.prepare("SELECT run_json, request_hash FROM audiobook_runs ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(500, Math.trunc(limit)))) as unknown as RunRow[];
    return rows.map(normalizeRun);
  }

  confirm(id: string, planHash: string): AudiobookRun {
    let run = this.require(id);
    if (run.state === "approved" && run.receipt?.planHash === planHash) return run;
    if (run.state !== "draft") throw new Error("Only a draft plan can be confirmed");
    if (run.planHash !== planHash) throw new Error("Plan changed; review the latest immutable plan hash before confirming");
    if (run.blockers.length > 0) throw new Error(`Plan has ${run.blockers.length} unresolved blocker(s)`);
    const approvedAt = new Date().toISOString();
    const receiptShape = {
      planHash: run.planHash,
      provider: run.provider,
      host: run.providerHost,
      sectionIds: [...new Set(run.chunks.map(({ sectionId }) => sectionId))],
      evidenceIds: [...new Set(run.chunks.flatMap(({ evidenceIds }) => evidenceIds))],
      characters: run.totalCharacters,
      estimatedCostUsd: run.estimatedCostUsd,
      approvedAt,
    };
    run = { ...run, state: "approved", receipt: { id: sha256(JSON.stringify(receiptShape)), ...receiptShape } };
    return this.save(run);
  }

  pause(id: string): AudiobookRun {
    const run = this.require(id);
    if (run.state !== "running") throw new Error("Only a running audiobook can be paused");
    run.state = "paused";
    return this.save(run);
  }

  cancel(id: string): AudiobookRun {
    let run = this.require(id);
    if (["completed", "cancelled"].includes(run.state)) return run;
    for (const chunk of run.chunks) {
      if (chunk.state === "running" && chunk.audioJobId) this.audio.cancel(chunk.audioJobId);
      if (["planned", "running", "interrupted"].includes(chunk.state)) chunk.state = "cancelled";
    }
    run.state = "cancelled";
    return this.save(run);
  }

  async retryChunk(id: string, chunkId: string): Promise<AudiobookRun> {
    let run = this.require(id);
    if (run.state === "completed") throw new Error("A completed package cannot be mutated");
    const chunk = run.chunks.find(({ id: candidate }) => candidate === chunkId);
    if (!chunk) throw new Error(`Unknown production chunk: ${chunkId}`);
    if (!["failed", "cancelled", "interrupted"].includes(chunk.state)) throw new Error("Only failed, cancelled, or interrupted chunks can be explicitly retried");
    if (chunk.audioJobId) {
      const job = this.audio.get(chunk.audioJobId);
      if (job?.status === "failed" || job?.status === "cancelled") this.audio.retry(job.id);
      else if (job?.status === "running") throw new Error("The provider job is still running");
      else if (job?.status === "completed") {
        if (chunk.qc.state === "failed" && chunk.artifact) {
          chunk.priorArtifacts = [
            ...(chunk.priorArtifacts ?? []),
            {
              artifact: chunk.artifact,
              qc: chunk.qc,
              reason: "Structurally invalid or otherwise failed audiobook QC",
              supersededAt: new Date().toISOString(),
            },
          ];
          this.audio.regenerateCompleted(job.id);
          chunk.artifact = undefined;
          chunk.state = "planned";
          chunk.error = undefined;
          chunk.qc = { state: "pending", checks: [] };
          run.state = "paused";
          return this.save(run);
        }
        chunk.artifact = job.artifact;
        chunk.state = "generated";
        chunk.qc = qcForChunk(chunk, await this.audio.readArtifact(job.id));
        chunk.error = undefined;
        run.state = "paused";
        return this.save(run);
      }
    }
    chunk.state = "planned";
    chunk.error = undefined;
    chunk.qc = { state: "pending", checks: [] };
    run.state = "paused";
    return this.save(run);
  }

  assertProcessable(id: string): AudiobookRun {
    const run = this.require(id);
    if (!["approved", "paused", "failed", "budget-exhausted"].includes(run.state)) {
      throw new Error("Audiobook must be approved or explicitly resumed from a stopped state");
    }
    if (!run.receipt) throw new Error("Approval receipt is missing");
    if (run.chunks.some(({ state }) => ["failed", "cancelled", "interrupted", "stale"].includes(state))) {
      throw new Error("Resolve failed, cancelled, interrupted, or stale chunks before resuming");
    }
    return run;
  }

  recordProcessingFailure(id: string, error: unknown): AudiobookRun {
    const run = this.require(id);
    if (run.state !== "running") return run;
    const message = error instanceof Error ? error.message : "Unexpected audiobook processing failure";
    const chunk = run.chunks.find(({ state }) => state === "running") ?? run.chunks.find(({ state }) => state === "planned");
    if (chunk) {
      chunk.state = "failed";
      chunk.error = message;
      chunk.qc = { state: "failed", checks: [{ code: "processing-failed", severity: "error", message }] };
    }
    run.state = "failed";
    return this.save(run);
  }

  async process(id: string, providers: VoiceProviderRegistry, options: ProcessAudiobookOptions = {}): Promise<AudiobookRun> {
    try {
      return await this.processUnchecked(id, providers, options);
    } catch (error) {
      if (this.get(id)?.state === "running") return this.recordProcessingFailure(id, error);
      throw error;
    }
  }

  private async processUnchecked(id: string, providers: VoiceProviderRegistry, options: ProcessAudiobookOptions): Promise<AudiobookRun> {
    let run = this.assertProcessable(id);
    run.state = "running";
    run = this.save(run);

    for (const planned of run.chunks) {
      run = this.require(id);
      if (run.state !== "running") return run;
      const chunk = run.chunks.find(({ id: candidate }) => candidate === planned.id)!;
      if (chunk.state === "generated") continue;

      if (options.validateChunk && !(await options.validateChunk(chunk))) {
        chunk.state = "stale";
        chunk.error = "The cited source script changed after plan approval; create a new plan";
        run.state = "stale";
        return this.save(run);
      }

      let job = this.audio.enqueue(chunk.request);
      let reusedArtifact = false;
      chunk.audioJobId = job.id;
      if (job.status === "completed") {
        chunk.reused = true;
        reusedArtifact = true;
      } else {
        if (job.status === "failed" || job.status === "cancelled" || (job.status === "queued" && job.attempts > 0 && chunk.dispatches === 0)) {
          chunk.state = job.status === "cancelled" ? "cancelled" : job.status === "queued" ? "interrupted" : "failed";
          chunk.error = job.error ?? "An existing incomplete provider job requires explicit retry";
          run.state = "failed";
          return this.save(run);
        }
        const reservationAlreadyRecorded = chunk.dispatches > job.attempts;
        if (!reservationAlreadyRecorded) {
          const nextCost = Number((run.committedCostUsd + chunk.estimatedCostUsd).toFixed(6));
          if (nextCost > run.budget.maxCostUsd || run.providerRequests + 1 > run.budget.maxProviderRequests) {
            run.state = "budget-exhausted";
            chunk.error = "Dispatch stopped before exceeding the approved cost or request ceiling";
            return this.save(run);
          }
          run.committedCostUsd = nextCost;
          run.providerRequests += 1;
          chunk.dispatches += 1;
        }
        chunk.state = "running";
        run = this.save(run);
        await options.afterDispatchReserved?.(chunk);
        job = (await this.audio.processJob(job.id, providers)) ?? this.audio.get(job.id)!;
      }

      run = this.require(id);
      const current = run.chunks.find(({ id: candidate }) => candidate === planned.id)!;
      if (run.state === "cancelled") return run;
      if (job.status !== "completed" || !job.artifact) {
        current.state = job.status === "cancelled" ? "cancelled" : "failed";
        current.error = job.error ?? "Audio synthesis did not produce an artifact";
        run.state = job.status === "cancelled" ? "cancelled" : "failed";
        return this.save(run);
      }
      current.artifact = job.artifact;
      current.audioJobId = job.id;
      current.reused = reusedArtifact;
      current.qc = qcForChunk(current, await this.audio.readArtifact(job.id));
      current.state = current.qc.state === "failed" ? "failed" : "generated";
      current.error = current.qc.state === "failed" ? "Generated audio failed structural or timing QC; explicitly retry this part" : undefined;
      run = this.save(run);
      if (current.state === "failed") {
        run.state = "failed";
        return this.save(run);
      }
    }

    run = this.require(id);
    if (run.state === "running") {
      run.state = run.chunks.some(({ qc }) => qc.state === "failed") ? "failed" : "needs-review";
      run = this.save(run);
    }
    return run;
  }

  approveReview(id: string, review: ReviewInput): AudiobookRun {
    let run = this.require(id);
    if (run.state !== "needs-review") throw new Error("Audiobook must finish generation before QC review");
    if (run.chunks.some(({ state, artifact, qc }) => state !== "generated" || !artifact || qc.state === "pending")) {
      throw new Error("Every audiobook part must have a generated, checked artifact before review approval");
    }
    const errors = run.chunks.flatMap(({ qc }) => qc.checks).filter(({ severity }) => severity === "error");
    if (errors.length > 0) throw new Error("QC errors must be resolved before approval");
    const hasWarnings = run.chunks.some(({ qc }) => qc.state === "warning");
    if (hasWarnings && !review.reason?.trim()) throw new Error("A review reason is required to waive QC warnings");
    const reviewedAt = new Date().toISOString();
    for (const chunk of run.chunks) {
      chunk.qc = {
        ...chunk.qc,
        state: chunk.qc.state === "warning" ? "waived" : "passed",
        reviewedBy: review.reviewer,
        reviewedAt,
        reviewReason: review.reason?.trim() || undefined,
      };
    }
    run.state = "completed";
    return this.save(run);
  }

  async exportPackage(id: string, authorization: ExportAuthorization): Promise<AudiobookRun> {
    let run = this.require(id);
    if (run.state !== "completed" || !run.receipt) throw new Error("Only a completed, reviewed audiobook can be exported");
    if (!authorization.affirmed) throw new Error("A separate export-use affirmation is required");
    if (authorization.purpose === "redistribution" && run.rights.scope !== "redistribution") {
      throw new Error("This run attests private listening only; create and confirm a redistribution-rights plan before exporting for distribution");
    }
    if (run.chunks.some(({ artifact, qc }) => !artifact || !["passed", "waived"].includes(qc.state))) {
      throw new Error("Every chunk must have a reviewed artifact before export");
    }
    const stagingPath = await mkdtemp(join(this.rootPath, ".audiobook-export-"));
    const packagePath = stagingPath;
    let published = false;
    try {
      const chaptersPath = join(packagePath, "chapters");
      await mkdir(chaptersPath, { recursive: true });

      const checksumLines: string[] = [];
      const manifestChunks: ExportedAudiobookManifest["chunks"] = [];
      for (const chunk of run.chunks) {
      const artifact = chunk.artifact!;
      const extension = artifact.mimeType === "audio/wav" ? "wav" : "mp3";
      const relativeFile = `chapters/${String(chunk.sectionSequence + 1).padStart(2, "0")}-${safeSegment(chunk.sectionTitle)}.part-${String(chunk.chunkSequence + 1).padStart(3, "0")}.${extension}`;
      const bytes = await this.audio.readArtifact(artifact.jobId);
      if (sha256(bytes) !== artifact.contentHash) throw new Error(`Artifact integrity check failed for ${chunk.id}`);
      const containerError = audioContainerError(bytes, artifact.mimeType);
      if (containerError) throw new Error(`Artifact format check failed for ${chunk.id}: ${containerError}`);
      await writeFile(join(packagePath, relativeFile), bytes);
      checksumLines.push(checksumLine(artifact.contentHash, relativeFile));
      manifestChunks.push({
        id: chunk.id,
        sequence: chunk.sequence,
        sectionId: chunk.sectionId,
        sectionTitle: chunk.sectionTitle,
        sectionSequence: chunk.sectionSequence,
        chunkSequence: chunk.chunkSequence,
        pages: [chunk.startPage, chunk.endPage],
        sourceScriptId: chunk.sourceScriptId,
        sourceScriptRevision: chunk.sourceScriptRevision,
        evidenceScope: chunk.evidenceScope,
        readingCharacterRange: chunk.readingCharacterRange,
        sourceCharacterRange: chunk.sourceCharacterRange,
        evidenceIds: chunk.evidenceIds,
        evidence: chunk.request.script.evidence,
        readingText: chunk.request.script.readingText,
        sourceTextHash: sha256(chunk.request.script.sourceText),
        readingTextHash: sha256(chunk.request.script.readingText),
        artifact: { file: relativeFile, contentHash: artifact.contentHash, mimeType: artifact.mimeType, byteLength: artifact.byteLength },
        priorArtifacts: (chunk.priorArtifacts ?? []).map(({ artifact: prior, qc, reason, supersededAt }) => ({
          contentHash: prior.contentHash,
          mimeType: prior.mimeType,
          byteLength: prior.byteLength,
          qc,
          reason,
          supersededAt,
        })),
        timingQuality: artifact.timingQuality,
        qc: chunk.qc,
        disclosure: artifact.disclosure,
        reused: chunk.reused,
      });
      }
      const createdAt = new Date().toISOString();
      const manifest: ExportedAudiobookManifest = {
      schemaVersion: "1",
      audiobookId: run.id,
      planHash: run.planHash,
      document: { id: run.documentId, hash: run.documentHash, extractionRevision: run.extractionRevision },
      rights: run.rights,
      receipt: run.receipt,
      provider: { id: run.provider, host: run.providerHost, voice: run.voice, model: run.model, format: run.format, timingQuality: run.timingQuality },
      budget: { ...run.budget, estimatedCostUsd: run.estimatedCostUsd, committedCostUsd: run.committedCostUsd, providerRequests: run.providerRequests, pricing: run.pricing },
      pronunciation: run.pronunciation,
      sourceReview: run.sourceReview,
      authorizedUse: {
        purpose: authorization.purpose,
        attestor: authorization.attestor,
        affirmedAt: createdAt,
        notice: authorization.purpose === "redistribution"
          ? "The attestor affirmed redistribution rights; this receipt is not independent legal verification."
          : "Private backup/listening only. This export does not grant or attest redistribution rights.",
      },
      chunks: manifestChunks,
      createdAt,
      };
      const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
      const manifestHash = sha256(manifestJson);
      await writeFile(join(packagePath, "audiobook.json"), manifestJson);
      checksumLines.push(checksumLine(manifestHash, "audiobook.json"));
      const qcJson = `${JSON.stringify({ schemaVersion: "1", audiobookId: run.id, state: run.state, chunks: run.chunks.map(({ id: chunkId, qc }) => ({ id: chunkId, qc })) }, null, 2)}\n`;
      await writeFile(join(packagePath, "qc.json"), qcJson);
      checksumLines.push(checksumLine(sha256(qcJson), "qc.json"));
      const readme = `# Cited audiobook package\n\nThis is a reviewable set of independently verifiable chapter parts, not a commercially mastered audiobook.\n\n- Plan: ${run.planHash}\n- Rights receipt: ${run.receipt.id}\n- Authorized use: ${authorization.purpose === "redistribution" ? "redistribution rights affirmed by the attestor" : "private backup/listening only; no redistribution rights attested"}\n- Generated at: ${createdAt}\n- Read \`audiobook.json\` for source revisions, full evidence anchors, extraction-quality review, scripts, provider disclosure, and per-part files.\n- Verify every file with \`SHA256SUMS\`.\n`;
      await writeFile(join(packagePath, "README.md"), readme);
      checksumLines.push(checksumLine(sha256(readme), "README.md"));
      await writeFile(join(packagePath, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
      const finalPath = join(this.exportsPath, `${run.id}-${manifestHash.slice("sha256:".length, "sha256:".length + 12)}-${stagingPath.slice(-6)}`);
      await rename(stagingPath, finalPath);
      published = true;
      run.export = { path: finalPath, manifestHash, createdAt };
      return this.save(run);
    } finally {
      if (!published) await rm(stagingPath, { recursive: true, force: true });
    }
  }

  private require(id: string): AudiobookRun {
    const run = this.get(id);
    if (!run) throw new Error(`Unknown audiobook run: ${id}`);
    return run;
  }
}
