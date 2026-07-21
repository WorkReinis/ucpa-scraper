import test from "node:test";
import assert from "node:assert/strict";
import {
  collectKeys, pickFullest, pooledRemaining, mask, screenAndPick,
} from "../src/providers/apify-keys.mjs";
import { configuredProviders } from "../src/providers/index.mjs";
import { buildApifyInput } from "../src/providers/apify.mjs";
import { buildSerpApiParams } from "../src/providers/serpapi.mjs";

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

function fakeAccountResponse(remainingUsd) {
  return {
    me: { username: "fixture", plan: { id: "free" } },
    limits: {
      limits: { maxMonthlyUsageUsd: 10 },
      current: { monthlyUsageUsd: 10 - remainingUsd },
      monthlyUsageCycle: { endAt: "2026-08-01T00:00:00.000Z" },
    },
  };
}

// inspectKey fires /users/me and /users/me/limits for every key through the
// SAME outer Promise.all screenAndPick runs across keys -- so the order
// fetch calls actually arrive in is unspecified. The handler gets the real
// bearer token (not call order) so a test can control one specific key's
// behavior deterministically.
function fakeFetch(handler) {
  return async (url, options) => {
    const token = options?.headers?.Authorization?.replace(/^Bearer /, "");
    const body = handler(url, token);
    if (body == null) return { ok: false, status: 500, json: async () => ({ error: { message: "fixture outage" } }) };
    return { ok: true, status: 200, json: async () => body };
  };
}

test("a screening blip affecting every key is retried once before being trusted", async () => {
  const env = { APIFY_KEY_1: "tok-a", APIFY_KEY_2: "tok-b" };
  let round = 0;
  // Every key fails the first round (mirrors the live 2026-07 observation:
  // all 5 keys read "fetch failed" simultaneously, then succeeded on a
  // manual retry seconds later) -- the second round is healthy.
  const fetchImpl = fakeFetch((url) => {
    if (round < 4) { round++; return null; } // 2 keys x 2 endpoints = 4 calls in round 1
    const account = fakeAccountResponse(3.5);
    return url.includes("/limits") ? account.limits : account.me;
  });

  const result = await screenAndPick(env, fetchImpl, { retryDelayMs: 1 });
  assert.equal(result.fullest?.remainingUsd, 3.5);
  assert.equal(result.rows.every((r) => !r.error), true);
});

test("a genuine mixed result (some keys really empty, one really broken) is trusted immediately", async () => {
  const env = { APIFY_KEY_1: "tok-a", APIFY_KEY_2: "tok-b" };
  const started = Date.now();
  const fetchImpl = fakeFetch((url, token) => {
    if (token === "tok-a") return null; // key 1: a real, persistent auth error
    const account = fakeAccountResponse(0); // key 2: real, confirmed zero balance
    return url.includes("/limits") ? account.limits : account.me;
  });

  const result = await screenAndPick(env, fetchImpl, { retryDelayMs: 5000 });
  // Not every row errored (key 2 gave a real reading), so no retry fires --
  // this returns well under the retry delay, and the errored key is simply
  // excluded rather than blocking the real (if unhelpful) zero-balance read.
  assert.ok(Date.now() - started < 2000);
  assert.equal(result.fullest, null);
  assert.equal(result.rows.find((r) => r.name === "APIFY_KEY_1").error, "fixture outage");
  assert.equal(result.rows.find((r) => r.name === "APIFY_KEY_2").remainingUsd, 0);
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

test("both flight providers use the NL market and allow at most one stop", () => {
  const options = {
    originIds: "AMS,RTM", destIds: "GVA,LYS",
    outboundDate: "2026-12-05", returnDate: "2026-12-12", apiKey: "secret",
  };
  const apify = buildApifyInput(options);
  assert.equal(apify.gl, "nl");
  assert.equal(apify.max_stops, 1);
  assert.equal(apify.fetch_booking_options, false);
  assert.equal(apify.max_pages, 1);
  const serp = buildSerpApiParams(options);
  assert.equal(serp.get("gl"), "nl");
  assert.equal(serp.get("stops"), "2");

  const deepApify = buildApifyInput({ ...options, exhaustive: true });
  assert.equal(deepApify.max_pages, 2);
  const deepSerp = buildSerpApiParams({ ...options, exhaustive: true });
  assert.equal(deepSerp.get("show_hidden"), "true");
  assert.equal(deepSerp.get("deep_search"), "true");
  assert.equal(deepSerp.get("sort_by"), "2");
});
