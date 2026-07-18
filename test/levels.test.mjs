import test from "node:test";
import assert from "node:assert/strict";
import { tierOf, tierRank, TIER_ORDER } from "../src/levels.mjs";

test("difficulty tiers run from least to most experienced", () => {
  assert.deepEqual(TIER_ORDER.slice(0, 5), ["Beginner", "Novice", "Intermediate", "Advanced", "Expert"]);
  assert.ok(tierRank("Beginner") < tierRank("Novice"));
  assert.ok(tierRank("Novice") < tierRank("Intermediate"));
  assert.ok(tierRank("Intermediate") < tierRank("Advanced"));
  assert.ok(tierRank("Advanced") < tierRank("Expert"));
});

test("difficulty tiers reflect minimum entry experience across activity tracks", () => {
  assert.equal(tierOf("Ski - Débutant"), "Beginner");
  assert.equal(tierOf("Ski - initié à expert"), "Novice");
  assert.equal(tierOf("Ski hors-piste - Découverte"), "Intermediate");
  assert.equal(tierOf("Ski de randonnée - Niveau 1"), "Intermediate");
  assert.equal(tierOf("Ski hors-piste - All Mountain"), "Advanced");
  assert.equal(tierOf("Ski de randonnée - Niveau 2"), "Advanced");
  assert.equal(tierOf("Ski hors-piste - Expert"), "Expert");
});
