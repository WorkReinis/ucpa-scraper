import test from "node:test";
import assert from "node:assert/strict";
import { open, insertFlightPrice } from "../src/db.mjs";
import { AIRPORT_CONFIG_KEY } from "../src/airports.mjs";
import { flightCoverageReport } from "../src/validate-airports.mjs";

function daysFromNow(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("coverage report distinguishes current cells, legacy fallbacks, and missing cells", () => {
  const db = open(":memory:");
  const start = daysFromNow(60);
  const early = daysFromNow(59);
  const end = daysFromNow(66);
  db.prepare(
    `INSERT INTO product (code, resort, region, first_seen, last_seen)
     VALUES ('fixture', 'Valloire', 'Alpes du Nord', datetime('now'), datetime('now'))`
  ).run();
  db.prepare(
    `INSERT INTO week
       (code, start_date, end_date, price, status, seats_left, booked, observed_at)
     VALUES ('fixture', ?, ?, 700, 'Available', 5, 0, datetime('now'))`
  ).run(start, end);

  insertFlightPrice(db, {
    origins: "AMS,RTM", dests: "CMF,GNB,GVA,LYS", gateway: "northern-alps",
    origin_group: "nl", arrival_mode: "standard", provider: "apify",
    config_key: AIRPORT_CONFIG_KEY, outbound_date: start, return_date: end,
    price: 180, pricing_mode: "roundtrip", dep_airport: "AMS", arr_airport: "LYS",
    airline: "Fixture Air", stops: 0, duration_min: 95, details_scope: "both",
    outbound_segments: [{ departure_at: `${start} 08:00`, arrival_at: `${start} 09:35` }],
    return_dep_airport: "LYS", return_arr_airport: "AMS", return_airline: "Fixture Air",
    return_stops: 0, return_duration_min: 95,
    return_segments: [{ departure_at: `${end} 14:00`, arrival_at: `${end} 15:35` }],
    candidate_count: 3, window_dropped: 0, date_dropped: 0, stops_dropped: 0,
    return_candidate_count: 2, return_window_dropped: 0, return_date_dropped: 0,
    return_stops_dropped: 0,
  });
  insertFlightPrice(db, {
    origins: "AMS,RTM", dests: "CMF,GNB,GVA,LYS", gateway: "northern-alps",
    origin_group: "nl", arrival_mode: "early", provider: "serpapi",
    config_key: "legacy", outbound_date: early, return_date: end,
    price: 190, pricing_mode: "legacy", dep_airport: "AMS", arr_airport: "LYS",
    airline: "Fixture Air", stops: 0, duration_min: 95, details_scope: "outbound",
    outbound_segments: [{ departure_at: `${early} 08:00`, arrival_at: `${early} 09:35` }],
  });

  const report = flightCoverageReport(db);
  // 2 origin groups (nl, uk -- ch was retired 2026-07) x 2 arrival modes.
  assert.equal(report.expected, 4);
  assert.equal(report.current, 1);
  assert.equal(report.priced, 1);
  assert.equal(report.missing, 3);
  assert.equal(report.legacyFallbacks, 1);
  assert.equal(report.invalidDateCells, 0);
  assert.equal(report.excessiveStopCells, 0);
  assert.equal(report.complete, false);
  db.close();
});
