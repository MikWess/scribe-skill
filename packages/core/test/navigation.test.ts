import assert from "node:assert/strict";
import test from "node:test";

import { navigateSkill, validateNavigationGuide } from "../src/navigation.ts";
import guide from "../fixtures/navigation-guide.json" with { type: "json" };
import type { SkillNavigationGuide } from "../src/contracts.ts";

const fixture = guide as SkillNavigationGuide;

test("routes a task to chapters, graph context, and source verification", () => {
  const decision = navigateSkill(fixture, "How should I apply evidence provenance to graph claims?");

  assert.deepEqual(decision.routeIds, ["provenance"]);
  assert.deepEqual(
    decision.context.map(({ source }) => source),
    ["chapter", "graph-neighborhood", "passage-search"],
  );
  assert.equal(decision.unmatched, false);
});

test("falls back to cited passage search instead of guessing", () => {
  const decision = navigateSkill(fixture, "Does the author recommend sourdough starters?");

  assert.equal(decision.unmatched, true);
  assert.equal(decision.context[0]?.source, "passage-search");
  assert.match(decision.usageInstructions.join(" "), /unsupported/);
});

test("fixture is a valid evidence-required navigation guide", () => {
  assert.deepEqual(validateNavigationGuide(fixture), []);
});
