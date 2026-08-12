import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, protocol, session } from "electron";

import { startLocalService, type LocalServiceHandle } from "../../local-service/src/server.ts";

protocol.registerSchemesAsPrivileged([
  { scheme: "scribe-skill", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let service: LocalServiceHandle | undefined;
let shuttingDown = false;

async function createWindow(): Promise<void> {
  const token = service?.token ?? randomBytes(32).toString("base64url");
  service ??= await startLocalService({
      token,
      workspacePath: join(app.getPath("userData"), "library"),
    allowedOrigins: ["scribe-skill://app"],
    });

  const smokePdf =
    process.env.SCRIBE_SKILL_DESKTOP_SMOKE_PDF ??
    process.argv.find((argument) => argument.startsWith("--scribe-smoke-pdf="))?.slice("--scribe-smoke-pdf=".length);
  if (smokePdf) {
    const imported = await fetch(`${service.url}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-scribe-token": token },
      body: JSON.stringify({ path: smokePdf }),
    });
    const result = await imported.json() as { document?: { id: string }; error?: string };
    if (!imported.ok || !result.document) throw new Error(result.error ?? "Desktop smoke import failed");
    const page = await fetch(`${service.url}/api/documents/${result.document.id}/pages/1`, {
      headers: { "x-scribe-token": token },
    });
    if (!page.ok) throw new Error("Desktop smoke page inspection failed");
    const marker = `SCRIBE_SKILL_DESKTOP_SMOKE_OK ${result.document.id}`;
    process.stdout.write(`${marker}\n`);
    const resultPath = process.argv
      .find((argument) => argument.startsWith("--scribe-smoke-result="))
      ?.slice("--scribe-smoke-result=".length);
    if (resultPath) await writeFile(resultPath, `${marker}\n`);
    app.quit();
    return;
  }

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  const readerRoot = join(dirname(fileURLToPath(import.meta.url)), "../dist");
  protocol.handle("scribe-skill", async (request) => {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const target = join(readerRoot, pathname);
    if (!target.startsWith(`${readerRoot}/`) && target !== join(readerRoot, "index.html")) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(await readFile(target));
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; img-src 'self' blob: http://127.0.0.1:*; connect-src http://127.0.0.1:*; style-src 'self' 'unsafe-inline'",
        ],
      },
    });
  });

  const window = new BrowserWindow({
    title: "ScribeSkill — cited reading workspace",
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 680,
    backgroundColor: "#17211d",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      additionalArguments: [`--scribe-api=${service.url}`, `--scribe-token=${token}`],
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());

  await window.loadURL("scribe-skill://app/");
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (!service || shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  void service.close().finally(() => {
    service = undefined;
    app.quit();
  });
});

app.whenReady().then(createWindow).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  const resultPath = process.argv
    .find((argument) => argument.startsWith("--scribe-smoke-result="))
    ?.slice("--scribe-smoke-result=".length);
  if (resultPath) await writeFile(resultPath, `SCRIBE_SKILL_DESKTOP_SMOKE_FAILED ${message}\n`);
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
