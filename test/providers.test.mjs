import test from "node:test";
import assert from "node:assert/strict";
import {
  collectKeys, pickFullest, pooledRemaining, mask,
} from "../src/providers/apify-keys.mjs";
import { configuredProviders } from "../src/providers/index.mjs";

test("key inventory dedupes identical tokens and keeps alias names", () => {
  const { unique, total } = collectKeys({
    APIFY_KEY_1: "tok-a",
    APIFY_KEY_2: "tok-b",
    APIFY_KEY_3: "tok-a",   // duplicate of key 1
    APIFY_KEY_4: "  ",      // blank -- ignored
    SERPAPI_KEY: "not-apify",
  });
  assert.equal(total, 3);
  assert.equal(unique.length, 2);
  assert.deepEqual(unique.map((k) => k.name), ["APIFY_KEY_1", "APIFY_KEY_2"]);
  assert.deepEqual(unique[0].aliases, ["APIFY_KEY_3"]);
  assert.equal(mask("apify_api_abcdWXYZ"), "…WXYZ");
});

test("the fullest account wins and errored accounts never count", () => {
  const rows = [
    { name: "APIFY_KEY_1", remainingUsd: 1.87, error: null },
    { name: "APIFY_KEY_2", remainingUsd: 0, error: null },
    { name: "APIFY_KEY_3", remainingUsd: 4.32, error: null },
    { name: "APIFY_KEY_4", remainingUsd: null, error: "HTTP 401" },
  ];
  assert.equal(pickFullest(rows).name, "APIFY_KEY_3");
  assert.equal(pooledRemaining(rows), 1.87 + 4.32);
  assert.equal(pickFullest([{ remainingUsd: 0, error: null }]), null);
});

test("provider order is apify first, serpapi fallback, per configuration", () => {
  assert.deepEqual(configuredProviders({ APIFY_KEY_1: "t", SERPAPI_KEY: "s" }), ["apify", "serpapi"]);
  assert.deepEqual(configuredProviders({ APIFY_KEY_1: "t" }), ["apify"]);
  assert.deepEqual(configuredProviders({ SERPAPI_KEY: "s" }), ["serpapi"]);
  assert.deepEqual(configuredProviders({}), []);
  assert.deepEqual(configuredProviders({ APIFY_KEY_9: "t" }), ["apify"]); // any APIFY_KEY_* counts
});

test("FLIGHT_PROVIDER forces a single provider only when it is configured", () => {
  const both = { APIFY_KEY_1: "t", SERPAPI_KEY: "s" };
  assert.deepEqual(configuredProviders({ ...both, FLIGHT_PROVIDER: "serpapi" }), ["serpapi"]);
  assert.deepEqual(configuredProviders({ ...both, FLIGHT_PROVIDER: "apify" }), ["apify"]);
  // Forcing a provider that has no credentials yields none rather than
  // silently falling back to the other one.
  assert.deepEqual(configuredProviders({ APIFY_KEY_1: "t", FLIGHT_PROVIDER: "serpapi" }), []);
  assert.deepEqual(configuredProviders({ SERPAPI_KEY: "s", FLIGHT_PROVIDER: "apify" }), []);
});
