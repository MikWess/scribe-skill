import assert from "node:assert/strict";
import test from "node:test";

import { navigateSkill, parseNavigationGuide, validateNavigationGuide } from "../src/navigation.ts";
import guide from "../fixtures/navigation-guide.json" with { type: "json" };
import type { SkillNavigationGuide } from "../src/contracts.ts";

const fixture = parseNavigationGuide(guide) as SkillNavigationGuide;

test("routes a task to chapters, graph context, and source verification", () => {
  const decision = navigateSkill(fixture, "How should I apply evidence provenance to graph claims?");

  assert.deepEqual(decision.routeIds, ["provenance"]);
  assert.deepEqual(
    decision.context.map(({ source }) => source),
    ["chapter", "passage-search", "graph-neighborhood"],
  );
  assert.equal(decision.unmatched, false);
  assert.ok(decision.allocatedTokens <= decision.maxTotalTokens);
  assert.deepEqual(decision.context[0]?.evidenceAnchorIds, ["anchor-provenance-1"]);
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

test("rejects imported guides that assert evidence without anchors", () => {
  const broken = structuredClone(guide);
  broken.routes[0]!.context[0]!.evidenceAnchorIds = ["missing-anchor"];

  assert.throws(() => parseNavigationGuide(broken), /missing evidence/);
});

test("bounds route count and total context allocation", () => {
  const many = structuredClone(guide);
  many.routes = Array.from({ length: 100 }, (_, index) => ({
    ...structuredClone(guide.routes[0]!),
    id: `route-${index}`,
    triggers: ["evidence"],
  }));
  const parsed = parseNavigationGuide(many);
  const decision = navigateSkill(parsed, "evidence", { maxRoutes: 2, maxTotalTokens: 2_000 });

  assert.equal(decision.routeIds.length, 2);
  assert.equal(decision.allocatedTokens, 2_000);
  assert.equal(decision.candidates.filter(({ selected }) => selected).length, 2);
});
