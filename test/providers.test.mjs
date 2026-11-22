import test from "node:test";
import assert from "node:assert/strict";
import { configuredProviders } from "../src/providers/index.mjs";
import { buildSerpApiParams } from "../src/providers/serpapi.mjs";

test("SerpApi is the sole configured flight provider", () => {
  assert.deepEqual(configuredProviders({ SERPAPI_KEY: "key" }), ["serpapi"]);
  assert.deepEqual(configuredProviders({ SERPAPI_KEY: "  " }), []);
  assert.deepEqual(configuredProviders({}), []);
});

test("SerpApi uses the NL market and allows at most one stop", () => {
  const options = {
    originIds: "AMS,RTM", destIds: "GVA,LYS",
    outboundDate: "2026-12-05", returnDate: "2026-12-12", apiKey: "secret",
  };
  const params = buildSerpApiParams(options);
  assert.equal(params.get("gl"), "nl");
  assert.equal(params.get("stops"), "2");

  const deep = buildSerpApiParams({ ...options, exhaustive: true });
  assert.equal(deep.get("show_hidden"), "true");
  assert.equal(deep.get("deep_search"), "true");
  assert.equal(deep.get("sort_by"), "2");
});
