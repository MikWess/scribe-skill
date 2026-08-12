import assert from "node:assert/strict";
import test from "node:test";

import {
  navigateSkill,
  NavigationGuideValidationError,
  parseNavigationGuide,
  validateNavigationGuide,
} from "../src/navigation.ts";
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

test("malformed route, context, evidence, and policy fail with controlled validation errors", () => {
  const cases: unknown[] = [
    { ...structuredClone(guide), routes: [null] },
    {
      ...structuredClone(guide),
      routes: [{ ...structuredClone(guide.routes[0]!), context: [null] }],
    },
    { ...structuredClone(guide), evidence: { broken: null } },
    { ...structuredClone(guide), answerPolicy: null },
  ];

  for (const value of cases) {
    assert.throws(() => parseNavigationGuide(value), NavigationGuideValidationError);
  }
});

test("arbitrary JSON never leaks a raw runtime error from the parser", () => {
  let seed = 0x5c12beef;
  const next = () => ((seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) / 0x1_0000_0000);
  const arbitrary = (depth: number): unknown => {
    const kind = Math.floor(next() * (depth > 2 ? 4 : 6));
    if (kind === 0) return null;
    if (kind === 1) return next() > 0.5;
    if (kind === 2) return Math.floor(next() * 1_000);
    if (kind === 3) return `value-${Math.floor(next() * 1_000)}`;
    if (kind === 4) return Array.from({ length: Math.floor(next() * 4) }, () => arbitrary(depth + 1));
    return Object.fromEntries(
      Array.from({ length: Math.floor(next() * 4) }, (_, index) => [`key-${index}`, arbitrary(depth + 1)]),
    );
  };

  for (let index = 0; index < 500; index += 1) {
    try {
      parseNavigationGuide(arbitrary(0));
    } catch (error) {
      assert.ok(error instanceof NavigationGuideValidationError);
    }
  }
});
