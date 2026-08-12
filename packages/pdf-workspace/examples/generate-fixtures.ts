import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const outputPath = resolve(process.argv.slice(2).find((argument) => argument !== "--") ?? "work/fixtures");
await mkdir(outputPath, { recursive: true });

const digital = await PDFDocument.create();
const font = await digital.embedFont(StandardFonts.Helvetica);
const digitalPage = digital.addPage([600, 800]);
digitalPage.drawText("Evidence Systems", { x: 50, y: 750, size: 22, font });
digitalPage.drawText("Durable citations bind claims to source spans.", {
  x: 50,
  y: 690,
  size: 11,
  font,
});
digitalPage.drawText("Extraction confidence flags uncertain pages.", {
  x: 50,
  y: 660,
  size: 11,
  font,
});
digitalPage.drawText("Graph edges remain derived context.", {
  x: 330,
  y: 690,
  size: 11,
  font,
});
digitalPage.drawText("Agents verify exact source passages.", {
  x: 330,
  y: 660,
  size: 11,
  font,
});
const cleanPage = digital.addPage([600, 800]);
cleanPage.drawText("A simple page can be used immediately without reading-order repair.", {
  x: 50,
  y: 720,
  size: 12,
  font,
});
cleanPage.drawText("Every block still receives an exact durable evidence anchor.", {
  x: 50,
  y: 690,
  size: 12,
  font,
});
await writeFile(resolve(outputPath, "digital-two-column.pdf"), await digital.save());

const scanned = await PDFDocument.create();
const scannedPage = scanned.addPage([600, 800]);
scannedPage.drawRectangle({ x: 40, y: 40, width: 520, height: 720, color: rgb(0.94, 0.94, 0.92) });
scannedPage.drawLine({ start: { x: 80, y: 700 }, end: { x: 520, y: 700 }, thickness: 8 });
await writeFile(resolve(outputPath, "image-only.pdf"), await scanned.save());

process.stdout.write(`Generated fixtures in ${outputPath}\n`);
