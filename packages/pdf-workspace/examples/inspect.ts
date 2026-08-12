import { resolve } from "node:path";

import { PdfWorkspace } from "@scribe-skill/pdf-workspace";

const argumentsWithoutSeparator = process.argv.slice(2).filter((argument) => argument !== "--");
const [pdfPath, workspacePath = ".scribe-skill-workspace"] = argumentsWithoutSeparator;
if (!pdfPath) {
  process.stderr.write("Usage: pnpm pdf:inspect <pdf-path> [workspace-path]\n");
  process.exit(2);
}

const workspace = await PdfWorkspace.open(resolve(workspacePath));
try {
  const document = await workspace.importPdf(resolve(pdfPath));
  const pages = workspace.listPages(document.id);
  const blocks = workspace.listBlocks(document.id);
  const inspection = await workspace.inspectPage(document.id, 1);
  process.stdout.write(
    `${JSON.stringify(
      {
        document,
        quality: pages.map(({ pageNumber, quality, confidence }) => ({ pageNumber, quality, confidence })),
        blockCount: blocks.length,
        inspectedPage: {
          renderPath: inspection.renderPath,
          renderHash: inspection.renderHash,
          blocks: inspection.blocks.map((block) => ({
            id: block.id,
            text: block.currentText,
            sourceText: block.sourceText,
            status: block.status,
            order: block.currentOrder,
            confidence: block.confidence,
            boundingBox: block.boundingBox,
          })),
        },
        firstEvidence: blocks[0] ? workspace.evidenceForBlock(blocks[0].id) : null,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  workspace.close();
}
