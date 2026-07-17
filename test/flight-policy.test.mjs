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
test("a pair gets at most two attempts per freshness window", () => {
  assert.equal(flightPolicy({ monthlyAttempts: 0, recentAttempts: 1, hasFreshQuote: false }), "search");
  assert.equal(
    flightPolicy({ monthlyAttempts: 0, recentAttempts: MAX_ATTEMPTS_PER_PAIR_WINDOW, hasFreshQuote: false }),
    "recent_attempts"
  );
  assert.equal(flightPolicy({ monthlyAttempts: 0, recentAttempts: 0, hasFreshQuote: true }), "fresh_quote");
  assert.equal(FLIGHT_REFRESH_DAYS, 6);
});
