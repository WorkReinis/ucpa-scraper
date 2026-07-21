import test from "node:test";
import assert from "node:assert/strict";
import {
  flightPolicy,
  FLIGHT_REFRESH_DAYS,
  MONTHLY_SEARCH_LIMIT,
  MAX_ATTEMPTS_PER_PAIR_WINDOW,
} from "../src/flights.mjs";

test("monthly flight quota stops at 225 attempts", () => {
  assert.equal(flightPolicy({ monthlyAttempts: 224, recentAttempts: 0, hasFreshQuote: false }), "search");
  assert.equal(flightPolicy({ monthlyAttempts: 225, recentAttempts: 0, hasFreshQuote: false }), "monthly_quota");
  assert.equal(flightPolicy({ monthlyAttempts: 226, recentAttempts: 0, hasFreshQuote: false }), "monthly_quota");
  assert.equal(MONTHLY_SEARCH_LIMIT, 225);
});
test("apify has no self-imposed run-count ceiling -- only SerpApi's real one gates", () => {
  // Apify's actual constraint is live account credit (providers/apify.mjs's
  // own reserve guard), checked at call time -- not a count agreed here in
  // advance. No monthlyAttempts value should ever trip "monthly_quota" for it.
  assert.equal(
    flightPolicy({ monthlyAttempts: 250, recentAttempts: 0, hasFreshQuote: false, provider: "apify" }),
    "search"
  );
  assert.equal(
    flightPolicy({ monthlyAttempts: Number.MAX_SAFE_INTEGER, recentAttempts: 0, hasFreshQuote: false, provider: "apify" }),
    "search"
  );
  // The same attempt count still stops SerpApi -- the provider argument
  // must pick the right (only real) ceiling.
  assert.equal(
    flightPolicy({ monthlyAttempts: 250, recentAttempts: 0, hasFreshQuote: false, provider: "serpapi" }),
    "monthly_quota"
  );
});
test("a pair gets at most two attempts per freshness window", () => {
  assert.equal(flightPolicy({ monthlyAttempts: 0, recentAttempts: 1, hasFreshQuote: false }), "search");
  assert.equal(
    flightPolicy({ monthlyAttempts: 0, recentAttempts: MAX_ATTEMPTS_PER_PAIR_WINDOW, hasFreshQuote: false }),
    "recent_attempts"
  );
  assert.equal(flightPolicy({ monthlyAttempts: 0, recentAttempts: 0, hasFreshQuote: true }), "fresh_quote");
  assert.equal(FLIGHT_REFRESH_DAYS, 6);
});
