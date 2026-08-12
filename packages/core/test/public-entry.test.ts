import assert from "node:assert/strict";
import test from "node:test";

import { navigateSkill, parseNavigationGuide, sha256 } from "@scribe-skill/core";
import guide from "../fixtures/navigation-guide.json" with { type: "json" };

test("a consumer can use the supported public package entry", () => {
  assert.match(sha256("consumer"), /^sha256:/);
  const decision = navigateSkill(parseNavigationGuide(guide), "verify provenance evidence");
  assert.deepEqual(decision.routeIds, ["provenance"]);
});
