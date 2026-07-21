import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  finishRun, insertFlightPrice, insertSourceSnapshot, open, startRun,
} from "../src/db.mjs";
import { AIRPORT_CONFIG_KEY } from "../src/airports.mjs";

test("flight storage preserves both directions' segments and price halves", () => {
  const db = open(":memory:");
  insertFlightPrice(db, {
    origins: "AMS,RTM", dests: "LYS", gateway: "northern-alps",
    origin_group: "nl", arrival_mode: "standard", provider: "apify",
    config_key: "coverage-v2",
    outbound_date: "2026-12-05", return_date: "2026-12-12",
    price: 161, price_outbound: 89, price_return: 72,
    pricing_mode: "separate",
    dep_airport: "AMS", arr_airport: "LYS", airline: "KLM + Air France",
    stops: 1, duration_min: 155, details_scope: "both",
    outbound_segments: [{ from: "AMS", to: "CDG" }, { from: "CDG", to: "LYS" }],
    return_dep_airport: "LYS", return_arr_airport: "RTM", return_airline: "Transavia",
    return_stops: 0, return_duration_min: 95,
    return_segments: [{ from: "LYS", to: "RTM" }],
    price_level: "typical",
  });
  const row = db.prepare(
    `SELECT outbound_segments, return_segments, details_scope, origin_group, arrival_mode,
            provider, config_key, pricing_mode, price, price_outbound, price_return, return_dep_airport, return_arr_airport
     FROM flight_price`
  ).get();
  assert.equal(row.details_scope, "both");
  assert.deepEqual(JSON.parse(row.outbound_segments).map((segment) => segment.to), ["CDG", "LYS"]);
  assert.deepEqual(JSON.parse(row.return_segments).map((segment) => segment.to), ["RTM"]);
  assert.equal(row.origin_group, "nl");
  assert.equal(row.arrival_mode, "standard");
  assert.equal(row.provider, "apify");
  assert.equal(row.config_key, "coverage-v2");
  assert.equal(row.pricing_mode, "separate");
  assert.equal(row.price, 161);
  assert.equal(row.price_outbound, 89);
  assert.equal(row.price_return, 72);
  assert.equal(row.return_dep_airport, "LYS");
  assert.equal(row.return_arr_airport, "RTM");
});

test("legacy flight rows migrate as the nl/early/serpapi cell they factually are", () => {
  // Pre-origin-group databases quoted AMS,RTM with outbound_date = start-1
  // via SerpApi, so the migration defaults must tag them exactly so --
  // they then seed the nl/early freshness cell instead of being re-searched.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ucpa-migrate-")), "legacy.db");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE flight_price (
      origins TEXT NOT NULL, dests TEXT NOT NULL, gateway TEXT NOT NULL,
      outbound_date TEXT NOT NULL, return_date TEXT NOT NULL, fetched_at TEXT NOT NULL,
      price REAL, dep_airport TEXT, arr_airport TEXT, airline TEXT,
      stops INTEGER, duration_min INTEGER, outbound_segments TEXT,
      details_scope TEXT NOT NULL DEFAULT 'outbound', price_level TEXT,
      PRIMARY KEY (origins, dests, outbound_date, return_date, fetched_at)
    );
    INSERT INTO flight_price (origins, dests, gateway, outbound_date, return_date, fetched_at, price)
    VALUES ('AMS,RTM', 'LDE,TLS', 'pyrenees', '2026-12-05', '2026-12-13', '2026-07-01T00:00:00Z', 180);
    CREATE TABLE flight_search (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outbound_date TEXT NOT NULL, return_date TEXT NOT NULL, attempted_at TEXT NOT NULL,
      week_key TEXT NOT NULL, billing_month TEXT NOT NULL, config_key TEXT NOT NULL,
      status TEXT NOT NULL, error TEXT
    );
  `);
  legacy.close();

  const db = open(file);
  const row = db.prepare(
    "SELECT origin_group, arrival_mode, provider, config_key, pricing_mode, price, details_scope, price_outbound, return_segments FROM flight_price"
  ).get();
  // spread: node:sqlite rows are null-prototype objects, which deepEqual rejects
  assert.deepEqual({ ...row }, {
    origin_group: "nl", arrival_mode: "early", provider: "serpapi", config_key: "legacy", pricing_mode: "legacy", price: 180,
    // Legacy rows stay round-trip-scoped with null one-way halves.
    details_scope: "outbound", price_outbound: null, return_segments: null,
  });
  const searchCols = db.prepare("PRAGMA table_info(flight_search)").all().map((c) => c.name);
  assert.ok(searchCols.includes("arrival_mode"));
  assert.ok(searchCols.includes("provider"));
  assert.ok(searchCols.includes("direction"));
  const priceCols = db.prepare("PRAGMA table_info(flight_price)").all().map((c) => c.name);
  assert.ok(priceCols.includes("config_key"));
  assert.ok(priceCols.includes("pricing_mode"));
  db.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("current flight view keeps trusted round-trip fallbacks and rejects one-way sums", () => {
  const db = open(":memory:");
  const insert = db.prepare(`
    INSERT INTO flight_price (
      origins, dests, gateway, origin_group, arrival_mode, provider, config_key,
      outbound_date, return_date, fetched_at, price, price_outbound, price_return,
      pricing_mode, details_scope
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const common = ["AMS,RTM", "LYS", "northern-alps", "nl", "early", "serpapi"];

  // Genuine historical Google Flights round-trip result.
  insert.run(...common, "legacy", "2026-12-05", "2026-12-12", "2026-07-19T16:17:00Z", 214, null, null, "legacy", "outbound");
  // Newer but invalid result made by adding two independent one-way fares.
  insert.run(...common, "legacy", "2026-12-05", "2026-12-12", "2026-07-19T20:36:00Z", 300, 176, 124, "legacy", "both");

  let row = db.prepare("SELECT price, config_key FROM v_flight_current").get();
  assert.equal(row.price, 214);
  assert.equal(row.config_key, "legacy");

  // A quote from the current policy supersedes the fallback cell by cell.
  insert.run(...common, AIRPORT_CONFIG_KEY, "2026-12-05", "2026-12-12", "2026-07-20T08:00:00Z", 213, null, null, "roundtrip", "both");
  row = db.prepare("SELECT price, config_key FROM v_flight_current").get();
  assert.equal(row.price, 213);
  assert.equal(row.config_key, AIRPORT_CONFIG_KEY);
  db.close();
});

test("a tuning-stale config_key doesn't orphan a separate-priced quote whose airports are still allowed", () => {
  const db = open(":memory:");
  const insert = db.prepare(`
    INSERT INTO flight_price (
      origins, dests, gateway, origin_group, arrival_mode, provider, config_key,
      outbound_date, return_date, fetched_at, price, price_outbound, price_return,
      pricing_mode, details_scope, dep_airport, arr_airport, return_dep_airport, return_arr_airport
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const common = ["AMS,RTM", "LYS,GVA,GNB,CMF", "northern-alps", "nl", "standard", "apify"];

  // A worse but strictly-shaped legacy round-trip fallback -- the only thing
  // that would show without the fix below.
  insert.run(...common, "legacy", "2026-12-05", "2026-12-12", "2026-07-16T08:00:00Z", 206, null, null, "legacy", "outbound", null, null, null, null);

  // A real, separately-priced quote fetched under an old config_key (from
  // before a tuning change, e.g. ZRH's cut) -- using GVA, which was never
  // affected and is still allowed today.
  const staleButCompliant = "search:separate-one-way-pair-v5:...|northern-alps:CMF=2,GNB=2.25,GVA=3,LYS=3,ZRH=4.5|...";
  insert.run(...common, staleButCompliant, "2026-12-05", "2026-12-12", "2026-07-20T13:00:00Z", 183, 117, 66, "separate", "both", "AMS", "GVA", "GVA", "AMS");

  const row = db.prepare("SELECT price, config_key FROM v_flight_current").get();
  assert.equal(row.price, 183, "the real, still-compliant quote should win over the worse legacy fallback");
  assert.equal(row.config_key, staleButCompliant);
  db.close();
});

test("a tuning-stale quote pinned to a since-retired airport stays orphaned, not promoted", () => {
  const db = open(":memory:");
  const insert = db.prepare(`
    INSERT INTO flight_price (
      origins, dests, gateway, origin_group, arrival_mode, provider, config_key,
      outbound_date, return_date, fetched_at, price, price_outbound, price_return,
      pricing_mode, details_scope, dep_airport, arr_airport, return_dep_airport, return_arr_airport
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const common = ["LHR,LGW,LTN,STN,LCY", "LYS,GVA,GNB,CMF,ZRH", "northern-alps", "uk", "standard", "apify"];

  const legacyKey = "search:separate-one-way-pair-v5:...|northern-alps:CMF=2,GNB=2.25,GVA=3,LYS=3,ZRH=4.5|...";
  // Fetched before ZRH was cut, and it actually used ZRH -- still real and
  // separately priced, but not something today's policy would produce.
  insert.run(...common, legacyKey, "2026-12-05", "2026-12-12", "2026-07-20T13:00:00Z", 132, 69, 63, "separate", "both", "LGW", "ZRH", "ZRH", "LGW");
  // A worse but genuinely policy-compliant round-trip fallback.
  insert.run(...common, "legacy", "2026-12-05", "2026-12-12", "2026-07-19T16:00:00Z", 152, null, null, "legacy", "outbound", null, null, null, null);

  const row = db.prepare("SELECT price, config_key FROM v_flight_current").get();
  assert.equal(row.price, 152, "a since-retired airport must not be promoted even though it was separately priced");
  assert.equal(row.config_key, "legacy");
  db.close();
});

test("catalogue metadata can be rolled back with the rest of a rejected run", () => {
  const db = open(":memory:");
  db.exec("BEGIN");
  const runId = startRun(db, "test source");
  insertSourceSnapshot(db, runId, {
    source: "test source", count: 10, candidateCount: 10, unparseableCount: 0,
  });
  finishRun(db, runId, 10);
  db.exec("ROLLBACK");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM run").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM source_snapshot").get().n, 0);
});
