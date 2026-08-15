import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AudioWorkspace,
  ElevenLabsVoiceProvider,
  OpenAiVoiceProvider,
  createNarrationScript,
} from "@scribe-skill/audio";
import type { AudioJob, NarrationRequest, VoiceCapability, VoiceProviderRegistry } from "@scribe-skill/audio";
import { AudiobookWorkspace } from "@scribe-skill/audiobook";
import type { CreateAudiobookPlanInput, ProductionChunk } from "@scribe-skill/audiobook";
import { getCodexCapability, sha256 } from "@scribe-skill/core";
import type { Capability, EvidenceAnchor } from "@scribe-skill/core";
import { PdfWorkspace } from "@scribe-skill/pdf-workspace";

const insecureDevelopmentToken = "local-development-only";

export interface LocalServiceOptions {
  host?: string;
  port?: number;
  token: string;
  workspacePath: string;
  allowedOrigins?: string[];
  resolveProviderKey?: (provider: "openai" | "elevenlabs") => Promise<string | undefined>;
  resolveCodexCapability?: () => Promise<Capability>;
  createProviderRegistry?: () => Promise<VoiceProviderRegistry>;
}

export interface LocalServiceHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}

function send(response: ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
  response.writeHead(status, {
    "content-type": contentType,
  });
  response.end(contentType === "application/json" ? JSON.stringify(body) : body);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
}

async function rawBody(request: IncomingMessage, limit = 100 * 1024 * 1024): Promise<Buffer> {
  const declaredSize = Number(request.headers["content-length"] ?? 0);
  if (declaredSize > limit) throw new Error("PDF is larger than the 100 MB local import limit");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("PDF is larger than the 100 MB local import limit");
    chunks.push(buffer);
  }
  if (size === 0) throw new Error("PDF file is empty");
  return Buffer.concat(chunks);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function startLocalService(options: LocalServiceOptions): Promise<LocalServiceHandle> {
const host = options.host ?? "127.0.0.1";
const requestedPort = options.port ?? 0;
if (!options.token) throw new Error("A non-empty local service token is required");
const token = options.token;
const allowedOrigins = new Set(options.allowedOrigins ?? []);
const workspace = await PdfWorkspace.open(resolve(options.workspacePath));
const audio = await AudioWorkspace.open(join(workspace.rootPath, "audio"));
const audiobooks = await AudiobookWorkspace.open(join(workspace.rootPath, "audio", "production"), audio);
const resolveProviderKey = options.resolveProviderKey ?? (async (provider) =>
  provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ELEVENLABS_API_KEY);
let codexCapabilityPromise: Promise<Capability> | undefined;
const resolveCodexCapability = () =>
  codexCapabilityPromise ??= (options.resolveCodexCapability ?? (() => getCodexCapability()))();
let processingTail: Promise<void> = Promise.resolve();

function scheduleAudioWork(task: () => Promise<void>): void {
  const scheduled = processingTail.then(task, task);
  processingTail = scheduled.catch(() => undefined);
}

async function providerRegistry(): Promise<VoiceProviderRegistry> {
  if (options.createProviderRegistry) {
    return {
      openai: new OpenAiVoiceProvider(undefined),
      elevenlabs: new ElevenLabsVoiceProvider(undefined),
      ...await options.createProviderRegistry(),
    };
  }
  const [openaiKey, elevenlabsKey] = await Promise.all([
    resolveProviderKey("openai"),
    resolveProviderKey("elevenlabs"),
  ]);
  return {
    openai: new OpenAiVoiceProvider(openaiKey),
    elevenlabs: new ElevenLabsVoiceProvider(elevenlabsKey),
  };
}

async function capabilities(): Promise<{ voices: VoiceCapability[]; codex: Capability }> {
  const providers = await providerRegistry();
  return {
    voices: [
      {
        provider: "device",
        available: false,
        requiresApiKey: false,
        timingQuality: "estimated-sentence",
        streaming: true,
        reason: "Device voice availability is detected in the browser",
      },
      providers.openai!.capability(),
      providers.elevenlabs!.capability(),
    ],
    codex: await resolveCodexCapability(),
  };
}

async function drainAudioQueue(): Promise<void> {
  scheduleAudioWork(async () => {
    while (await audio.processNext(await providerRegistry())) {
      // Keep draining until the atomic claim reports that no queued job remains.
    }
  });
}

function scriptForSection(sectionId: string, readingText?: string, revision = 1) {
  const section = workspace.getSection(sectionId);
  if (!section) throw new Error(`Unknown section: ${sectionId}`);
  const blocks = workspace.listIncludedBlocksInPageRange(section.documentId, section.startPage, section.endPage);
  if (blocks.length === 0) throw new Error("This section has no included extracted text to narrate");
  const sourceText = blocks.map(({ sourceText }) => sourceText).join("\n\n");
  const defaultReadingText = blocks.map(({ currentText }) => currentText).join("\n\n");
  const evidence = blocks.map(({ id }) => workspace.evidenceForBlock(id));
  if (readingText === undefined) {
    const latest = audio.latestScript(section.id);
    if (latest && latest.sourceText === sourceText && JSON.stringify(latest.evidence) === JSON.stringify(evidence)) return latest;
  }
  return createNarrationScript(section.id, sourceText, readingText ?? defaultReadingText, evidence, revision);
}

function sourceQuality(documentId: string, startPage: number, endPage: number): "good" | "review-needed" | "ocr-required" {
  const qualities = workspace.listPages(documentId)
    .filter(({ pageNumber }) => pageNumber >= startPage && pageNumber <= endPage)
    .map(({ quality }) => quality);
  if (qualities.includes("ocr-required")) return "ocr-required";
  if (qualities.includes("review-needed")) return "review-needed";
  return "good";
}

function currentChunkSource(chunk: ProductionChunk): boolean {
  try {
    return scriptForSection(chunk.sectionId).id === chunk.sourceScriptId;
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  try {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    if (origin && !allowedOrigins.has(origin)) return send(response, 403, { error: "Origin is not allowed" });
    if (origin) response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-headers", "content-type,x-scribe-token,idempotency-key");
    response.setHeader("access-control-allow-methods", "GET,POST,PATCH,PUT,OPTIONS");
    if (request.method === "OPTIONS") return send(response, 204, "", "text/plain");
    if (request.headers["x-scribe-token"] !== token) return send(response, 401, { error: "Unauthorized" });
    const url = new URL(request.url ?? "/", `http://${host}:${requestedPort}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return send(response, 200, { status: "ok", workspace: workspace.rootPath });
    }
    if (request.method === "GET" && url.pathname === "/api/capabilities") {
      return send(response, 200, await capabilities());
    }
    if (request.method === "POST" && url.pathname === "/api/import") {
      const input = await body(request);
      if (typeof input.path !== "string") return send(response, 400, { error: "PDF path is required" });
      const document = await workspace.importPdf(input.path);
      return send(response, 201, { document, sections: workspace.listSections(document.id) });
    }
    if (request.method === "POST" && url.pathname === "/api/import-file") {
      const requestedName = basename(url.searchParams.get("name") ?? "import.pdf");
      const safeName = requestedName.toLowerCase().endsWith(".pdf") ? requestedName : `${requestedName}.pdf`;
      const temporaryDirectory = await mkdtemp(join(tmpdir(), "scribe-skill-import-"));
      const temporaryPath = join(temporaryDirectory, safeName);
      try {
        await writeFile(temporaryPath, await rawBody(request));
        const document = await workspace.importPdf(temporaryPath);
        return send(response, 201, { document, sections: workspace.listSections(document.id) });
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }

    const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
    if (request.method === "GET" && documentMatch) {
      const document = workspace.getDocument(documentMatch[1]!);
      if (!document) return send(response, 404, { error: "Document is not in this workspace" });
      await workspace.verifyDocumentAsset(document.id);
      return send(response, 200, { document, sections: workspace.listSections(document.id) });
    }

    const pageMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/pages\/(\d+)$/);
    if (request.method === "GET" && pageMatch) {
      const [, documentId, page] = pageMatch;
      const inspection = await workspace.inspectPage(documentId!, Number(page));
      return send(response, 200, {
        ...inspection,
        renderUrl: `/api/documents/${documentId}/renders/${page}`,
        renderPath: undefined,
      });
    }
    const renderMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/renders\/(\d+)$/);
    if (request.method === "GET" && renderMatch) {
      const inspection = await workspace.inspectPage(renderMatch[1]!, Number(renderMatch[2]));
      return send(response, 200, await readFile(inspection.renderPath), "image/png");
    }

    const sectionsMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/sections$/);
    if (request.method === "GET" && sectionsMatch) {
      return send(response, 200, workspace.listSections(sectionsMatch[1]!));
    }
    const sectionMatch = url.pathname.match(/^\/api\/sections\/([^/]+)$/);
    const narrationScriptMatch = url.pathname.match(/^\/api\/sections\/([^/]+)\/narration-script$/);
    if (request.method === "GET" && narrationScriptMatch) {
      return send(response, 200, scriptForSection(narrationScriptMatch[1]!));
    }
    if (request.method === "POST" && narrationScriptMatch) {
      const input = await body(request);
      if (typeof input.readingText !== "string" || !input.readingText.trim()) {
        return send(response, 400, { error: "Narration reading text is required" });
      }
      const revision = Number(input.revision);
      if (!Number.isSafeInteger(revision) || revision < 1) return send(response, 400, { error: "A positive script revision is required" });
      return send(response, 201, audio.saveScript(scriptForSection(narrationScriptMatch[1]!, input.readingText, revision)));
    }
    if (request.method === "PATCH" && sectionMatch) {
      return send(response, 200, workspace.updateSection(sectionMatch[1]!, await body(request)));
    }

    if (request.method === "GET" && url.pathname === "/api/audiobooks") {
      return send(response, 200, audiobooks.list());
    }
    if (request.method === "POST" && url.pathname === "/api/audiobooks/plans") {
      const input = await body(request);
      const idempotencyKey = typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : "";
      if (!idempotencyKey.trim()) return send(response, 400, { error: "Idempotency-Key header is required" });
      if (typeof input.documentId !== "string") return send(response, 400, { error: "Document is required" });
      if (input.provider !== "openai" && input.provider !== "elevenlabs") return send(response, 400, { error: "Provider must be openai or elevenlabs" });
      if (!Array.isArray(input.sectionIds) || input.sectionIds.length === 0 || input.sectionIds.some((id) => typeof id !== "string")) {
        return send(response, 400, { error: "Select at least one section" });
      }
      if (new Set(input.sectionIds).size !== input.sectionIds.length) {
        return send(response, 400, { error: "Each selected section must be unique" });
      }
      if (typeof input.voice !== "string" || !input.voice.trim()) return send(response, 400, { error: "Voice is required" });
      const document = workspace.getDocument(input.documentId);
      if (!document) return send(response, 404, { error: "Document is not in this workspace" });
      await workspace.verifyDocumentAsset(document.id);
      const requestedSections = input.sectionIds.map((sectionId) => workspace.getSection(String(sectionId)));
      if (requestedSections.some((section) => !section || section.documentId !== document.id)) {
        return send(response, 400, { error: "Every selected section must belong to the document" });
      }
      const qualityApproved = new Set(Array.isArray(input.qualityApprovedSectionIds) ? input.qualityApprovedSectionIds.filter((id): id is string => typeof id === "string") : []);
      const providers = await providerRegistry();
      const capability = providers[input.provider]?.capability();
      if (!capability) return send(response, 400, { error: "Provider is not supported" });
      const requestedChunkSize = Number(input.maxChunkCharacters ?? (input.provider === "openai" ? 4000 : 10_000));
      if (!Number.isSafeInteger(requestedChunkSize) || requestedChunkSize < 32) return send(response, 400, { error: "Chunk size must be an integer of at least 32" });
      if (capability.maxCharacters && requestedChunkSize > capability.maxCharacters) {
        return send(response, 422, { error: `Chunk size exceeds the provider limit of ${capability.maxCharacters.toLocaleString()} characters` });
      }
      if (input.provider === "elevenlabs" && input.format === "wav") return send(response, 422, { error: "ElevenLabs timestamped narration currently exports MP3 only" });
      const pricingRate = Number(input.usdPerMillionCharacters);
      const maxCostUsd = Number(input.maxCostUsd);
      const maxCharacters = Number(input.maxCharacters);
      const maxProviderRequests = Number(input.maxProviderRequests);
      const pronunciation = Array.isArray(input.pronunciation)
        ? input.pronunciation.map((rule) => {
            const record = rule as Record<string, unknown>;
            return { source: String(record.source ?? ""), spoken: String(record.spoken ?? "") };
          })
        : [];
      const planInput: CreateAudiobookPlanInput = {
        documentId: document.id,
        documentHash: document.documentHash,
        extractionRevision: document.extractionRevision,
        sections: requestedSections.map((section) => ({
          sectionId: section!.id,
          title: section!.title,
          startPage: section!.startPage,
          endPage: section!.endPage,
          quality: sourceQuality(document.id, section!.startPage, section!.endPage),
          qualityApproved: qualityApproved.has(section!.id),
          script: scriptForSection(section!.id),
        })),
        provider: input.provider,
        providerHost: input.provider === "openai" ? "api.openai.com" : "api.elevenlabs.io",
        voice: input.voice.trim(),
        model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined,
        instructions: typeof input.instructions === "string" && input.instructions.trim() ? input.instructions.trim() : undefined,
        format: input.format === "wav" ? "wav" : "mp3",
        timingQuality: capability.timingQuality,
        maxChunkCharacters: requestedChunkSize,
        pricing: {
          kind: "user-supplied-per-million-characters",
          usdPerMillionCharacters: pricingRate,
          checkedAt: new Date().toISOString(),
          note: "Conservative user-supplied planning rate; provider billing may use a different unit and must be verified by the operator.",
        },
        budget: { maxCostUsd, maxCharacters, maxProviderRequests },
        rights: {
          affirmed: input.rightsAffirmed === true,
          scope: input.rightsScope === "redistribution" ? "redistribution" : "private-listening",
          attestor: input.attestor === "agent" ? "agent" : "user",
          statementVersion: "2026-08-15",
          affirmedAt: new Date().toISOString(),
        },
        pronunciation,
      };
      return send(response, 201, audiobooks.createPlan(planInput, idempotencyKey, sha256(canonicalJson(input))));
    }
    const audiobookMatch = url.pathname.match(/^\/api\/audiobooks\/([^/]+)$/);
    if (request.method === "GET" && audiobookMatch) {
      const run = audiobooks.get(audiobookMatch[1]!);
      return run ? send(response, 200, run) : send(response, 404, { error: "Audiobook run not found" });
    }
    const audiobookActionMatch = url.pathname.match(/^\/api\/audiobooks\/([^/]+)\/(confirm|start|pause|resume|cancel|approve|export)$/);
    if (request.method === "POST" && audiobookActionMatch) {
      const [, audiobookId, action] = audiobookActionMatch;
      const input = await body(request);
      if (action === "confirm") {
        if (typeof input.planHash !== "string") return send(response, 400, { error: "Exact plan hash is required" });
        return send(response, 200, audiobooks.confirm(audiobookId!, input.planHash));
      }
      if (action === "pause") return send(response, 200, audiobooks.pause(audiobookId!));
      if (action === "cancel") return send(response, 200, audiobooks.cancel(audiobookId!));
      if (action === "approve") {
        return send(response, 200, audiobooks.approveReview(audiobookId!, {
          reviewer: input.reviewer === "agent" ? "agent" : "user",
          reason: typeof input.reason === "string" ? input.reason : undefined,
        }));
      }
      if (action === "export") return send(response, 200, await audiobooks.exportPackage(audiobookId!, {
        affirmed: input.exportAffirmed === true,
        purpose: input.purpose === "redistribution" ? "redistribution" : "private-backup",
        attestor: input.attestor === "agent" ? "agent" : "user",
      }));
      const run = audiobooks.get(audiobookId!);
      if (!run) return send(response, 404, { error: "Audiobook run not found" });
      audiobooks.assertProcessable(audiobookId!);
      const providers = await providerRegistry();
      const capability = providers[run.provider]?.capability();
      if (!capability?.available) return send(response, 409, { error: capability?.reason ?? "Provider is unavailable" });
      scheduleAudioWork(async () => {
        await audiobooks.process(audiobookId!, providers, { validateChunk: currentChunkSource });
      });
      return send(response, 202, run);
    }
    const audiobookRetryMatch = url.pathname.match(/^\/api\/audiobooks\/([^/]+)\/chunks\/([^/]+)\/retry$/);
    if (request.method === "POST" && audiobookRetryMatch) {
      return send(response, 200, await audiobooks.retryChunk(audiobookRetryMatch[1]!, audiobookRetryMatch[2]!));
    }

    if (request.method === "GET" && url.pathname === "/api/audio/jobs") {
      const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200) {
        return send(response, 400, { error: "Audio job limit must be an integer from 1 to 200" });
      }
      return send(response, 200, audio.list(undefined, requestedLimit));
    }
    if (request.method === "POST" && url.pathname === "/api/audio/jobs") {
      const input = await body(request);
      if (input.provider !== "openai" && input.provider !== "elevenlabs") {
        return send(response, 400, { error: "Audio provider must be openai or elevenlabs" });
      }
      if (typeof input.sectionId !== "string" || typeof input.voice !== "string" || !input.voice.trim()) {
        return send(response, 400, { error: "Section and voice are required" });
      }
      const providers = await providerRegistry();
      const provider = providers[input.provider];
      const capability = provider?.capability();
      if (!capability?.available) return send(response, 409, { error: capability?.reason ?? "Provider is unavailable" });
      if (input.revision !== undefined && (typeof input.revision !== "number" || !Number.isSafeInteger(input.revision) || input.revision < 1)) {
        return send(response, 400, { error: "Narration revision must be a positive integer" });
      }
      const script = scriptForSection(
        input.sectionId,
        typeof input.readingText === "string" ? input.readingText : undefined,
        input.revision ?? 1,
      );
      if (capability.maxCharacters && script.readingText.length > capability.maxCharacters) {
        return send(response, 422, {
          error: `${input.provider === "openai" ? "OpenAI" : "Provider"} accepts at most ${capability.maxCharacters.toLocaleString()} characters per request; split this section before generating audio`,
        });
      }
      audio.saveScript(script);
      const narrationRequest: NarrationRequest = {
        script,
        provider: input.provider,
        voice: input.voice.trim(),
        model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined,
        instructions: typeof input.instructions === "string" && input.instructions.trim() ? input.instructions.trim() : undefined,
        format: input.format === "wav" ? "wav" : "mp3",
      };
      const job = audio.enqueue(narrationRequest);
      void drainAudioQueue();
      return send(response, 202, job);
    }
    const audioJobMatch = url.pathname.match(/^\/api\/audio\/jobs\/([^/]+)$/);
    if (request.method === "GET" && audioJobMatch) {
      const job = audio.get(audioJobMatch[1]!);
      return job ? send(response, 200, job) : send(response, 404, { error: "Audio job not found" });
    }
    const audioCancelMatch = url.pathname.match(/^\/api\/audio\/jobs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && audioCancelMatch) {
      return send(response, 200, audio.cancel(audioCancelMatch[1]!));
    }
    const audioRetryMatch = url.pathname.match(/^\/api\/audio\/jobs\/([^/]+)\/retry$/);
    if (request.method === "POST" && audioRetryMatch) {
      const job = audio.retry(audioRetryMatch[1]!);
      void drainAudioQueue();
      return send(response, 202, job);
    }
    const audioArtifactMatch = url.pathname.match(/^\/api\/audio\/jobs\/([^/]+)\/artifact$/);
    if (request.method === "GET" && audioArtifactMatch) {
      const job = audio.get(audioArtifactMatch[1]!);
      if (!job?.artifact) return send(response, 404, { error: "Audio artifact is not ready" });
      return send(response, 200, await audio.readArtifact(job.id), job.artifact.mimeType);
    }
    const blockMatch = url.pathname.match(/^\/api\/blocks\/([^/]+)$/);
    if (request.method === "PATCH" && blockMatch) {
      const input = await body(request);
      return send(
        response,
        200,
        workspace.editBlock(
          blockMatch[1]!,
          {
            text: typeof input.text === "string" ? input.text : undefined,
            order: typeof input.order === "number" ? input.order : undefined,
            status:
              input.status === "included" || input.status === "excluded" || input.status === "rejected"
                ? input.status
                : undefined,
          },
          typeof input.note === "string" ? input.note : "Reader repair",
        ),
      );
    }
    const reorderMatch = url.pathname.match(/^\/api\/blocks\/([^/]+)\/reorder$/);
    if (request.method === "POST" && reorderMatch) {
      const input = await body(request);
      if (input.direction !== -1 && input.direction !== 1) {
        return send(response, 400, { error: "Direction must be -1 or 1" });
      }
      return send(response, 200, workspace.reorderBlock(reorderMatch[1]!, input.direction));
    }
    const progressMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/progress$/);
    if (request.method === "GET" && progressMatch) {
      return send(response, 200, workspace.getProgress(progressMatch[1]!) ?? null);
    }
    if (request.method === "PUT" && progressMatch) {
      const input = await body(request);
      return send(
        response,
        200,
        workspace.saveProgress(
          progressMatch[1]!,
          Number(input.pageNumber),
          typeof input.blockId === "string" ? input.blockId : undefined,
        ),
      );
    }
    const annotationsMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/annotations$/);
    if (request.method === "GET" && annotationsMatch) {
      return send(response, 200, workspace.listAnnotations(annotationsMatch[1]!));
    }
    if (request.method === "POST" && annotationsMatch) {
      const input = await body(request);
      if (typeof input.blockId !== "string" || typeof input.content !== "string") {
        return send(response, 400, { error: "Block and content are required" });
      }
      return send(
        response,
        201,
        workspace.addAnnotation(
          annotationsMatch[1]!,
          input.blockId,
          input.kind === "highlight" ? "highlight" : "note",
          input.content,
          input.authorship === "source" || input.authorship === "model" ? input.authorship : "user",
        ),
      );
    }
    const exportMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/annotations\.md$/);
    if (request.method === "GET" && exportMatch) {
      return send(response, 200, workspace.exportAnnotationsMarkdown(exportMatch[1]!), "text/markdown; charset=utf-8");
    }
    const evidenceExportMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/annotations\.evidence\.json$/);
    if (request.method === "GET" && evidenceExportMatch) {
      return send(response, 200, workspace.exportAnnotationsEvidence(evidenceExportMatch[1]!));
    }
    return send(response, 404, { error: "Not found" });
  } catch (error) {
    return send(response, 400, { error: error instanceof Error ? error.message : "Unexpected error" });
  }
});

await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(requestedPort, host, () => resolveListen());
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Local service did not bind a TCP port");
let closed = false;
return {
  url: `http://${host}:${address.port}`,
  token,
  close: () =>
    new Promise<void>((resolveClose, rejectClose) => {
      if (closed) return resolveClose();
      closed = true;
      server.close((error) => {
        const audioClose = audio.close();
        void Promise.all([processingTail, audioClose]).then(() => {
          audiobooks.close();
          workspace.close();
          if (error) rejectClose(error);
          else resolveClose();
        }, rejectClose);
      });
    }),
};
}

async function runFromCommandLine(): Promise<void> {
  const token = process.env.SCRIBE_SKILL_TOKEN ??
    (process.env.SCRIBE_SKILL_ALLOW_INSECURE_DEV_TOKEN === "1" ? insecureDevelopmentToken : undefined);
  if (!token) {
    throw new Error(
      "SCRIBE_SKILL_TOKEN is required (or explicitly set SCRIBE_SKILL_ALLOW_INSECURE_DEV_TOKEN=1 for local development)",
    );
  }
  const handle = await startLocalService({
    host: "127.0.0.1",
    port: Number(process.env.SCRIBE_SKILL_PORT ?? 4317),
    token,
    workspacePath: process.env.SCRIBE_SKILL_WORKSPACE ?? "work/dev-library",
    allowedOrigins: (process.env.SCRIBE_SKILL_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  });
  process.stdout.write(`ScribeSkill local service: ${handle.url}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
      void handle.close().finally(() => process.exit(0));
  });
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFromCommandLine();
}
