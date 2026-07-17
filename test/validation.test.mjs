import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDetailFailureRate, detailIssues, productIssues, sourceIssues, wholePrice,
} from "../src/validation.mjs";
import { redactDiagnostic } from "../src/diagnostics.mjs";

const validProduct = {
  code: "sfavisn03",
  url: "https://www.ucpa.com/sejour/sfavisn03-example",
  title: "Snowboard package",
  resort: "Val d'Isère",
  region: "Alpes du Nord",
  activity: "Snowboard",
  level: "Snowboard - Initié à expert",
  price: 945,
  list_price: 1050,
};

test("product validation quarantines missing, unknown, and corrupted core fields", () => {
  assert.deepEqual(productIssues(validProduct), []);
  const issues = productIssues({
    ...validProduct,
    title: "x".repeat(181), activity: "New snow sport", level: "New level", price: null,
  });
  assert.ok(issues.includes("suspiciously long title"));
  assert.ok(issues.some((issue) => issue.startsWith("unknown activity")));
  assert.ok(issues.some((issue) => issue.startsWith("unknown level")));
  assert.ok(issues.includes("invalid package price"));
});

test("source validation catches partial loss and every unparseable candidate", () => {
  assert.deepEqual(sourceIssues({ count: 90, previousCount: 100, unparseableCount: 0 }), []);
  assert.ok(sourceIssues({ count: 84, previousCount: 100, unparseableCount: 0 })[0].includes("dropped"));
  assert.ok(sourceIssues({ count: 100, previousCount: 100, unparseableCount: 1 })[0].includes("could not be parsed"));
});

test("detail completeness and failure-rate gates reject silent empty parsing", () => {
  assert.deepEqual(detailIssues({ image_url: "https://img", includes: ["Board"], accommodation: "Chalet" }), []);
  assert.equal(detailIssues({ image_url: null, includes: [], accommodation: null }).length, 3);
  assert.doesNotThrow(() => assertDetailFailureRate(1, 10));
  assert.throws(() => assertDetailFailureRate(2, 10), /strict scrape rejected/);
});

test("all imported prices are whole euros rounded upward", () => {
  assert.equal(wholePrice(174.01), 175);
  assert.equal(wholePrice("945"), 945);
  assert.equal(wholePrice("not a price"), null);
});

test("diagnostic artifacts redact provider keys and echoed API URLs", () => {
  const key = "secret-provider-key";
  const text = `key=${key} url=https://serpapi.com/search?engine=google_flights&api_key=${key}&hl=en`;
  const redacted = redactDiagnostic(text, [key]);
  assert.equal(redacted.includes(key), false);
  assert.match(redacted, /api_key=\[REDACTED\]/);
});
