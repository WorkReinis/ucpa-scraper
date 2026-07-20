import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDetailFailureRate, detailIssues, flightQuoteIssues, productIssues, sourceIssues, wholePrice,
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

test("flight quote cells are shape-checked, and unquoted cells are fine", () => {
  assert.deepEqual(flightQuoteIssues(null), []);
  assert.deepEqual(flightQuoteIssues({ price: 224, dep_airport: "AMS", arr_airport: "LYS" }), []);
  assert.deepEqual(flightQuoteIssues({
    price: null, dep_airport: "BSL", arr_airport: "TLS",
    return_dep_airport: null, return_arr_airport: null,
  }), []);
  const issues = flightQuoteIssues({ price: 0, dep_airport: "Amsterdam", arr_airport: null });
  assert.equal(issues.length, 3);
  assert.match(issues[0], /invalid flight price/);
  assert.match(issues[1], /invalid departure airport/);
  assert.match(issues[2], /invalid arrival airport/);
  assert.equal(flightQuoteIssues({
    price: 180, dep_airport: "AMS", arr_airport: "LYS", details_scope: "both",
    return_dep_airport: null, return_arr_airport: null,
  }).length, 2);
  assert.deepEqual(flightQuoteIssues({
    price: 214, pricing_mode: "roundtrip", price_outbound: null, price_return: null,
    dep_airport: "AMS", arr_airport: "TLS",
  }), []);
  assert.match(flightQuoteIssues({
    price: 300, pricing_mode: "roundtrip", price_outbound: 176, price_return: 124,
    dep_airport: "AMS", arr_airport: "TLS",
  })[0], /must not contain additive/);
  assert.deepEqual(flightQuoteIssues({
    price: 300, pricing_mode: "separate", price_outbound: 176, price_return: 124,
    dep_airport: "AMS", arr_airport: "TLS",
  }), []);
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
