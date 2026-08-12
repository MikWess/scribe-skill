import guide from "../fixtures/navigation-guide.json" with { type: "json" };
import { navigateSkill, parseNavigationGuide } from "../src/navigation.ts";

const task = process.argv.slice(2).join(" ") || "How should I verify a graph claim with provenance?";
const decision = navigateSkill(parseNavigationGuide(guide), task);

process.stdout.write(`${JSON.stringify({ task, decision }, null, 2)}\n`);
