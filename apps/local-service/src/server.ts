import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PdfWorkspace } from "@scribe-skill/pdf-workspace";

const insecureDevelopmentToken = "local-development-only";

export interface LocalServiceOptions {
  host?: string;
  port?: number;
  token: string;
  workspacePath: string;
  allowedOrigins?: string[];
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

export async function startLocalService(options: LocalServiceOptions): Promise<LocalServiceHandle> {
const host = options.host ?? "127.0.0.1";
const requestedPort = options.port ?? 0;
if (!options.token) throw new Error("A non-empty local service token is required");
const token = options.token;
const allowedOrigins = new Set(options.allowedOrigins ?? []);
const workspace = await PdfWorkspace.open(resolve(options.workspacePath));

const server = createServer(async (request, response) => {
  try {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    if (origin && !allowedOrigins.has(origin)) return send(response, 403, { error: "Origin is not allowed" });
    if (origin) response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-headers", "content-type,x-scribe-token");
    response.setHeader("access-control-allow-methods", "GET,POST,PATCH,PUT,OPTIONS");
    if (request.method === "OPTIONS") return send(response, 204, "", "text/plain");
    if (request.headers["x-scribe-token"] !== token) return send(response, 401, { error: "Unauthorized" });
    const url = new URL(request.url ?? "/", `http://${host}:${requestedPort}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return send(response, 200, { status: "ok", workspace: workspace.rootPath });
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
    if (request.method === "PATCH" && sectionMatch) {
      return send(response, 200, workspace.updateSection(sectionMatch[1]!, await body(request)));
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
        workspace.close();
        if (error) rejectClose(error);
        else resolveClose();
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
