import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { sha256 } from "@scribe-skill/core";

import type {
  AudioJob,
  AudioJobStatus,
  NarrationArtifactRecord,
  NarrationRequest,
  VoiceProviderRegistry,
} from "./contracts.ts";
import { narrationCacheKey } from "./script.ts";

function normalizeArtifact(row: Record<string, unknown>): NarrationArtifactRecord | undefined {
  if (!row.artifact_hash) return undefined;
  return {
    jobId: String(row.id),
    contentHash: String(row.artifact_hash),
    mimeType: String(row.mime_type),
    byteLength: Number(row.byte_length),
    timingQuality: String(row.timing_quality) as NarrationArtifactRecord["timingQuality"],
    timings: JSON.parse(String(row.timings_json)) as NarrationArtifactRecord["timings"],
    disclosure: String(row.disclosure),
    createdAt: String(row.artifact_created_at),
  };
}

function normalizeJob(row: Record<string, unknown>): AudioJob {
  return {
    id: String(row.id),
    cacheKey: String(row.cache_key),
    status: String(row.status) as AudioJobStatus,
    request: JSON.parse(String(row.request_json)) as NarrationRequest,
    attempts: Number(row.attempts),
    error: row.error ? String(row.error) : undefined,
    artifact: normalizeArtifact(row),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class AudioWorkspace {
  readonly rootPath: string;
  readonly databasePath: string;
  readonly artifactsPath: string;
  private readonly database: DatabaseSync;
  private readonly controllers = new Map<string, AbortController>();
  private activeProcesses = 0;
  private idlePromise: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;
  private closePromise: Promise<void> | undefined;
  private closing = false;

  private constructor(rootPath: string, database: DatabaseSync) {
    this.rootPath = rootPath;
    this.databasePath = join(rootPath, "audio.sqlite");
    this.artifactsPath = join(rootPath, "artifacts");
    this.database = database;
  }

  static async open(rootPath: string): Promise<AudioWorkspace> {
    const absoluteRoot = resolve(rootPath);
    await mkdir(join(absoluteRoot, "artifacts"), { recursive: true });
    const database = new DatabaseSync(join(absoluteRoot, "audio.sqlite"));
    database.exec("PRAGMA journal_mode = WAL; PRAGMA application_id = 1397969748;");
    const workspace = new AudioWorkspace(absoluteRoot, database);
    workspace.migrate();
    workspace.recoverInterruptedJobs();
    return workspace;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.closePromise = this.idlePromise.then(() => this.database.close());
    return this.closePromise;
  }

  private migrate(): void {
    const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > 2) throw new Error(`Audio workspace schema ${version} is newer than this app supports`);
    if (version === 0) {
      this.runMigration(`
        CREATE TABLE audio_jobs (
          id TEXT PRIMARY KEY,
          cache_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
          request_json TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          artifact_hash TEXT,
          artifact_path TEXT,
          mime_type TEXT,
          byte_length INTEGER,
          timing_quality TEXT,
          timings_json TEXT,
          disclosure TEXT,
          artifact_created_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS audio_jobs_status_created ON audio_jobs(status, created_at);
        CREATE TABLE IF NOT EXISTS narration_scripts (
          id TEXT PRIMARY KEY,
          section_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          script_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS narration_scripts_section_revision ON narration_scripts(section_id, revision DESC, created_at DESC);
        PRAGMA user_version = 2;
      `);
    }
    if (version === 1) {
      this.runMigration(`
        CREATE TABLE IF NOT EXISTS narration_scripts (
          id TEXT PRIMARY KEY,
          section_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          script_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS narration_scripts_section_revision ON narration_scripts(section_id, revision DESC, created_at DESC);
        PRAGMA user_version = 2;
      `);
    }
  }

  private runMigration(sql: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(sql);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private recoverInterruptedJobs(): void {
    const updatedAt = new Date().toISOString();
    this.database
      .prepare("UPDATE audio_jobs SET status = 'queued', error = 'Recovered after restart', updated_at = ? WHERE status = 'running'")
      .run(updatedAt);
  }

  enqueue(request: NarrationRequest): AudioJob {
    if (request.provider === "device") throw new Error("Device voices preview in the browser and do not create server audio jobs");
    const cacheKey = narrationCacheKey(request);
    const id = `audio-${cacheKey.slice("sha256:".length)}`;
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO audio_jobs
         (id, cache_key, status, request_json, attempts, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, 0, ?, ?)`,
      )
      .run(id, cacheKey, JSON.stringify(request), createdAt, createdAt);
    return this.get(id)!;
  }

  saveScript(script: NarrationRequest["script"]): NarrationRequest["script"] {
    const latest = this.latestScript(script.sectionId);
    if (latest?.id === script.id) return latest;
    if (latest && script.revision <= latest.revision) {
      throw new Error(`Narration script revision must be greater than ${latest.revision}`);
    }
    this.database
      .prepare(
        `INSERT OR IGNORE INTO narration_scripts (id, section_id, revision, script_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(script.id, script.sectionId, script.revision, JSON.stringify(script), script.createdAt);
    return script;
  }

  latestScript(sectionId: string): NarrationRequest["script"] | undefined {
    const row = this.database
      .prepare("SELECT script_json FROM narration_scripts WHERE section_id = ? ORDER BY revision DESC, created_at DESC LIMIT 1")
      .get(sectionId);
    return row ? JSON.parse(String(row.script_json)) as NarrationRequest["script"] : undefined;
  }

  get(id: string): AudioJob | undefined {
    const row = this.database.prepare("SELECT * FROM audio_jobs WHERE id = ?").get(id);
    return row ? normalizeJob(row) : undefined;
  }

  list(status?: AudioJobStatus, limit = 50): AudioJob[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = status
      ? this.database.prepare("SELECT * FROM audio_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, boundedLimit)
      : this.database.prepare("SELECT * FROM audio_jobs ORDER BY created_at DESC LIMIT ?").all(boundedLimit);
    return rows.map(normalizeJob);
  }

  retry(id: string): AudioJob {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown audio job: ${id}`);
    if (current.status !== "failed" && current.status !== "cancelled") {
      throw new Error("Only failed or cancelled audio jobs can be retried");
    }
    const updatedAt = new Date().toISOString();
    this.database.prepare("UPDATE audio_jobs SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?").run(updatedAt, id);
    return this.get(id)!;
  }

  cancel(id: string): AudioJob {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown audio job: ${id}`);
    if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") return current;
    this.controllers.get(id)?.abort();
    const updatedAt = new Date().toISOString();
    this.database.prepare("UPDATE audio_jobs SET status = 'cancelled', error = NULL, updated_at = ? WHERE id = ?").run(updatedAt, id);
    return this.get(id)!;
  }

  async processNext(providers: VoiceProviderRegistry): Promise<AudioJob | undefined> {
    if (this.closing) return undefined;
    const row = this.database.prepare("SELECT * FROM audio_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get();
    if (!row) return undefined;
    const job = normalizeJob(row);
    const provider = job.request.provider === "device" ? undefined : providers[job.request.provider];
    if (!provider) return this.fail(job.id, `Provider ${job.request.provider} is not configured`);
    const capability = provider.capability();
    if (!capability.available) return this.fail(job.id, capability.reason ?? `Provider ${job.request.provider} is unavailable`);

    const updatedAt = new Date().toISOString();
    const claim = this.database
      .prepare("UPDATE audio_jobs SET status = 'running', attempts = attempts + 1, error = NULL, updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(updatedAt, job.id);
    if (Number(claim.changes) !== 1) return undefined;
    if (this.activeProcesses === 0) {
      this.idlePromise = new Promise<void>((resolveIdle) => { this.resolveIdle = resolveIdle; });
    }
    this.activeProcesses += 1;
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      const artifact = await provider.synthesize(job.request, controller.signal);
      if (this.get(job.id)?.status === "cancelled") return this.get(job.id);
      const contentHash = sha256(artifact.bytes);
      const extension = artifact.mimeType === "audio/wav" ? "wav" : "mp3";
      const artifactPath = join(this.artifactsPath, `${contentHash.slice("sha256:".length)}.${extension}`);
      await writeFile(artifactPath, artifact.bytes);
      const completedAt = new Date().toISOString();
      const completion = this.database
        .prepare(
          `UPDATE audio_jobs SET status = 'completed', artifact_hash = ?, artifact_path = ?, mime_type = ?,
           byte_length = ?, timing_quality = ?, timings_json = ?, disclosure = ?, artifact_created_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(
          contentHash,
          artifactPath,
          artifact.mimeType,
          artifact.bytes.byteLength,
          artifact.timingQuality,
          JSON.stringify(artifact.timings),
          artifact.disclosure,
          completedAt,
          completedAt,
          job.id,
        );
      if (Number(completion.changes) !== 1) return this.get(job.id);
      return this.get(job.id);
    } catch (error) {
      if (controller.signal.aborted || this.get(job.id)?.status === "cancelled") return this.get(job.id);
      return this.fail(job.id, error instanceof Error ? error.message : "Audio synthesis failed", false);
    } finally {
      this.controllers.delete(job.id);
      this.activeProcesses -= 1;
      if (this.activeProcesses === 0) {
        this.resolveIdle?.();
        this.resolveIdle = undefined;
      }
    }
  }

  private fail(id: string, message: string, incrementAttempt = true): AudioJob {
    const updatedAt = new Date().toISOString();
    this.database
      .prepare(`UPDATE audio_jobs SET status = 'failed', attempts = attempts + ?, error = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')`)
      .run(incrementAttempt ? 1 : 0, message, updatedAt, id);
    return this.get(id)!;
  }

  async readArtifact(id: string): Promise<Uint8Array> {
    const row = this.database.prepare("SELECT status, artifact_path, artifact_hash FROM audio_jobs WHERE id = ?").get(id);
    if (!row) throw new Error(`Unknown audio job: ${id}`);
    if (row.status !== "completed" || !row.artifact_path || !row.artifact_hash) throw new Error("Audio artifact is not ready");
    const bytes = new Uint8Array(await readFile(String(row.artifact_path)));
    if (sha256(bytes) !== String(row.artifact_hash)) throw new Error("Stored audio artifact failed its integrity check");
    return bytes;
  }
}
