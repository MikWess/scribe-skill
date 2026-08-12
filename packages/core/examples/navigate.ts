import guide from "../fixtures/navigation-guide.json" with { type: "json" };
import type { SkillNavigationGuide } from "../src/contracts.ts";
import { navigateSkill } from "../src/navigation.ts";

const task = process.argv.slice(2).join(" ") || "How should I verify a graph claim with provenance?";
const decision = navigateSkill(guide as SkillNavigationGuide, task);

process.stdout.write(`${JSON.stringify({ task, decision }, null, 2)}\n`);
