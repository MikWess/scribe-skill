import assert from "node:assert/strict";
import test from "node:test";

import { contentTypeForPath } from "../electron/content-type.ts";

test("desktop protocol serves executable assets with browser-safe MIME types", () => {
  assert.equal(contentTypeForPath("/reader/index.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeForPath("/reader/assets/app.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeForPath("/reader/assets/app.css"), "text/css; charset=utf-8");
});

test("desktop protocol falls back safely for unknown files", () => {
  assert.equal(contentTypeForPath("/reader/assets/book.data"), "application/octet-stream");
});
