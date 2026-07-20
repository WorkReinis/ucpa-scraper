import test from "node:test";
import assert from "node:assert/strict";
import {
  flightPolicy,
  FLIGHT_REFRESH_DAYS,
  MONTHLY_SEARCH_LIMIT,
  MAX_ATTEMPTS_PER_PAIR_WINDOW,
} from "../src/flights.mjs";
import { MONTHLY_RUN_LIMIT_APIFY } from "../src/providers/index.mjs";

test("monthly flight quota stops at 225 attempts", () => {
  assert.equal(flightPolicy({ monthlyAttempts: 224, recentAttempts: 0, hasFreshQuote: false }), "search");
  assert.equal(flightPolicy({ monthlyAttempts: 225, recentAttempts: 0, hasFreshQuote: false }), "monthly_quota");
  assert.equal(flightPolicy({ monthlyAttempts: 226, recentAttempts: 0, hasFreshQuote: false }), "monthly_quota");
  assert.equal(MONTHLY_SEARCH_LIMIT, 225);
});
test("the apify provider gets its own run-count ceiling", () => {
  assert.equal(MONTHLY_RUN_LIMIT_APIFY, 450);
  assert.equal(
    flightPolicy({ monthlyAttempts: 449, recentAttempts: 0, hasFreshQuote: false, provider: "apify" }),
    "search"
  );
  assert.equal(
    flightPolicy({ monthlyAttempts: 450, recentAttempts: 0, hasFreshQuote: false, provider: "apify" }),
    "monthly_quota"
  );
  // 226-299 is over the SerpApi limit but under the Apify one -- the
  // provider argument must pick the right ceiling.
  assert.equal(
    flightPolicy({ monthlyAttempts: 250, recentAttempts: 0, hasFreshQuote: false, provider: "apify" }),
    "search"
  );
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
