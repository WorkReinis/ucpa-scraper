import test from "node:test";
import assert from "node:assert/strict";
import {
  flightPolicy,
  isoWeekKey,
  MONTHLY_SEARCH_LIMIT,
  MAX_ATTEMPTS_PER_PAIR_WEEK,
} from "../src/flights.mjs";

test("monthly flight quota stops at 225 attempts", () => {
  assert.equal(flightPolicy({ monthlyAttempts: 224, weeklyAttempts: 0, hasQuoteThisWeek: false }), "search");
  assert.equal(flightPolicy({ monthlyAttempts: 225, weeklyAttempts: 0, hasQuoteThisWeek: false }), "monthly_quota");
  assert.equal(flightPolicy({ monthlyAttempts: 226, weeklyAttempts: 0, hasQuoteThisWeek: false }), "monthly_quota");
  assert.equal(MONTHLY_SEARCH_LIMIT, 225);
});
test("a pair gets at most two weekly attempts and one successful quote", () => {
  assert.equal(flightPolicy({ monthlyAttempts: 0, weeklyAttempts: 1, hasQuoteThisWeek: false }), "search");
  assert.equal(
    flightPolicy({ monthlyAttempts: 0, weeklyAttempts: MAX_ATTEMPTS_PER_PAIR_WEEK, hasQuoteThisWeek: false }),
    "weekly_attempts"
  );
  assert.equal(flightPolicy({ monthlyAttempts: 0, weeklyAttempts: 0, hasQuoteThisWeek: true }), "weekly_quote");
});

test("ISO week keys cross year boundaries correctly", () => {
  assert.equal(isoWeekKey("2027-01-01T12:00:00Z"), "2026-W53");
  assert.equal(isoWeekKey("2027-01-04T12:00:00Z"), "2027-W01");
});
