import test from "node:test";
import assert from "node:assert/strict";
import {
  finishRun, insertFlightPrice, insertSourceSnapshot, open, startRun,
} from "../src/db.mjs";

test("flight storage preserves structured outbound segments and explicit scope", () => {
  const db = open(":memory:");
  insertFlightPrice(db, {
    origins: "AMS,RTM", dests: "LYS", gateway: "northern-alps",
    outbound_date: "2026-12-05", return_date: "2026-12-12",
    price: 175, dep_airport: "AMS", arr_airport: "LYS", airline: "KLM + Air France",
    stops: 1, duration_min: 155, details_scope: "outbound",
    outbound_segments: [{ from: "AMS", to: "CDG" }, { from: "CDG", to: "LYS" }],
    price_level: "typical",
  });
  const row = db.prepare("SELECT outbound_segments, details_scope FROM flight_price").get();
  assert.equal(row.details_scope, "outbound");
  assert.deepEqual(JSON.parse(row.outbound_segments).map((segment) => segment.to), ["CDG", "LYS"]);
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
