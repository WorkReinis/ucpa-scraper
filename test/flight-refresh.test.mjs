import test from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/db.mjs";
import { AIRPORT_CONFIG_KEY } from "../src/airports.mjs";
import { runFlightRefresh } from "../src/flights.mjs";

function itinerary(from, to, price, date, departure, arrival) {
  return {
    price,
    total_duration: 95,
    flights: [{
      departure_airport: { id: from, time: `${date} ${departure}` },
      arrival_airport: { id: to, time: `${date} ${arrival}` },
      airline: "Fixture Air",
      duration: 95,
    }],
  };
}

function daysFromNow(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function fixtureDb() {
  const db = open(":memory:");
  db.prepare(
    `INSERT INTO product (code, resort, first_seen, last_seen)
     VALUES ('fixture', 'Val d''Isère', datetime('now'), datetime('now'))`
  ).run();
  db.prepare(
    `INSERT INTO week
       (code, start_date, end_date, price, status, seats_left, booked, observed_at)
     VALUES ('fixture', ?, ?, 700, 'Available', 5, 0, datetime('now'))`
  ).run(daysFromNow(60), daysFromNow(66));
  return db;
}

test("refresh recovers an origin market omitted by the broad flight matrix", async () => {
  const db = fixtureDb();

  const calls = [];
  const searchProvider = async ({ originIds, destIds, outboundDate, returnDate }) => {
    calls.push({ originIds, destIds, outboundDate, returnDate });
    const isReturn = originIds.includes("LYS") && !originIds.includes("AMS");
    const isBaselOnly = originIds === "BSL" || destIds === "BSL";
    let flights;
    if (isReturn && isBaselOnly) {
      flights = [itinerary("LYS", "BSL", 75, outboundDate, "14:00", "15:35")];
    } else if (isReturn) {
      flights = [
        itinerary("LYS", "AMS", 80, outboundDate, "14:00", "15:35"),
        itinerary("LYS", "LHR", 60, outboundDate, "14:15", "15:50"),
      ];
    } else if (isBaselOnly) {
      flights = [itinerary("BSL", "LYS", 65, outboundDate, "07:30", "09:05")];
    } else {
      flights = [
        itinerary("AMS", "LYS", 90, outboundDate, "07:00", "08:35"),
        itinerary("LHR", "LYS", 70, outboundDate, "07:15", "08:50"),
      ];
    }
    return {
      provider: "apify",
      secrets: [],
      raw: {
        search_parameters: { engine: "google_flights" },
        best_flights: flights,
        other_flights: [],
      },
    };
  };

  const summary = await runFlightRefresh({
    db,
    providerNames: ["apify"],
    searchProvider,
    delay: async () => {},
  });

  assert.equal(summary.failed, 0);
  assert.equal(summary.status, "success");
  assert.equal(summary.complete, true);
  assert.equal(summary.modesDue, 2);
  assert.equal(summary.modesCompleted, 2);
  assert.equal(summary.cellsDue, 6);
  assert.equal(summary.cellsStored, 6);
  assert.equal(summary.cellsMissing, 0);
  assert.equal(summary.recoverySearches, 3);
  assert.equal(calls.length, 6);
  assert.equal(calls.filter((call) => call.originIds === "BSL").length, 2);
  assert.equal(calls.filter((call) => call.destIds === "BSL").length, 1);
  assert.ok(calls.every((call) => !call.originIds.includes("TLS") && !call.destIds.includes("TLS")));
  assert.ok(calls.filter((call) => call.originIds === "BSL")
    .every((call) => call.destIds === "CMF,GNB,GVA,LYS,ZRH"));
  assert.ok(calls.filter((call) => call.destIds === "BSL")
    .every((call) => call.originIds === "CMF,GNB,GVA,LYS,ZRH"));
  assert.equal(calls.filter((call) => call.returnDate != null).length, 4);
  assert.ok(calls.filter((call) => call.returnDate != null).every((call) => call.returnDate === daysFromNow(66)));
  assert.ok(calls.filter((call) => call.returnDate == null).every((call) => call.originIds.includes("LYS")));

  const rows = db.prepare(
    `SELECT origin_group, arrival_mode, price, price_outbound, price_return, pricing_mode, config_key
     FROM v_flight_current ORDER BY origin_group, arrival_mode`
  ).all();
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.filter((row) => row.origin_group === "nl").map((row) => row.price), [90, 90]);
  assert.deepEqual(rows.filter((row) => row.origin_group === "ch").map((row) => row.price), [65, 65]);
  assert.ok(rows.every((row) => row.pricing_mode === "roundtrip"));
  assert.ok(rows.every((row) => row.price_outbound == null && row.price_return == null));
  assert.ok(rows.every((row) => row.config_key === AIRPORT_CONFIG_KEY));
  const freshSummary = await runFlightRefresh({
    db,
    providerNames: ["apify"],
    searchProvider: async () => { throw new Error("fresh quotes must not search"); },
    delay: async () => {},
  });
  assert.equal(freshSummary.status, "fresh");
  assert.equal(freshSummary.modesDue, 0);
  assert.equal(freshSummary.searched, 0);
  db.close();
});

test("refresh reports partial coverage when a recovery search fails", async () => {
  const db = fixtureDb();
  let calls = 0;
  const searchProvider = async ({ originIds, destIds, outboundDate }) => {
    calls++;
    if (originIds === "BSL" || destIds === "BSL") throw new Error("fixture provider failure");
    const isReturn = originIds.includes("LYS") && !originIds.includes("AMS");
    return {
      provider: "apify",
      secrets: [],
      raw: {
        search_parameters: { engine: "google_flights" },
        best_flights: isReturn
          ? [
              itinerary("LYS", "AMS", 80, outboundDate, "14:00", "15:35"),
              itinerary("LYS", "LHR", 60, outboundDate, "14:15", "15:50"),
            ]
          : [
              itinerary("AMS", "LYS", 90, outboundDate, "07:00", "08:35"),
              itinerary("LHR", "LYS", 70, outboundDate, "07:15", "08:50"),
            ],
        other_flights: [],
      },
    };
  };

  const summary = await runFlightRefresh({
    db,
    providerNames: ["apify"],
    searchProvider,
    delay: async () => {},
  });

  assert.equal(calls, 2);
  assert.equal(summary.status, "partial");
  assert.equal(summary.complete, false);
  assert.equal(summary.failed, 1);
  assert.equal(summary.modesDue, 2);
  assert.equal(summary.modesCompleted, 0);
  assert.equal(summary.cellsDue, 6);
  assert.equal(summary.cellsStored, 0);
  assert.equal(summary.cellsMissing, 6);
  assert.match(summary.errors[0], /fixture provider failure/);
  db.close();
});

test("refresh can target Basel without re-querying other origin markets", async () => {
  const db = fixtureDb();
  const calls = [];
  const searchProvider = async ({ originIds, destIds, outboundDate, returnDate }) => {
    calls.push({ originIds, destIds, outboundDate, returnDate });
    const isReturn = originIds.includes("LYS");
    return {
      provider: "serpapi",
      secrets: [],
      raw: {
        search_parameters: { engine: "google_flights" },
        best_flights: [isReturn
          ? itinerary("LYS", "BSL", 75, outboundDate, "14:00", "15:35")
          : itinerary("BSL", "LYS", 165, outboundDate, "07:30", "09:05")],
        other_flights: [],
      },
    };
  };

  const summary = await runFlightRefresh({
    db,
    providerNames: ["serpapi"],
    originGroupIds: ["ch"],
    searchProvider,
    delay: async () => {},
  });

  assert.equal(summary.complete, true);
  assert.deepEqual(summary.originGroups, ["ch"]);
  assert.equal(summary.cellsDue, 2);
  assert.equal(summary.cellsStored, 2);
  assert.equal(calls.length, 3);
  assert.equal(summary.broadSearches, 3);
  assert.equal(summary.targetedRetries, 0);
  assert.equal(summary.returnCacheHits, 0);
  assert.ok(calls.every((call) => call.originIds === "BSL" || call.destIds === "BSL"));
  assert.ok(calls.every((call) => !call.originIds.includes("AMS") && !call.destIds.includes("AMS")));
  assert.ok(calls.every((call) => !call.originIds.includes("TLS") && !call.destIds.includes("TLS")));
  const rows = db.prepare(
    "SELECT origin_group, arrival_mode, price FROM v_flight_current ORDER BY arrival_mode"
  ).all();
  assert.deepEqual(rows.map((row) => row.origin_group), ["ch", "ch"]);
  assert.deepEqual(rows.map((row) => row.price), [165, 165]);

  // Fare rows expire sooner than the independently cached return schedule.
  // A second fare cycle therefore needs only the two outbound round-trip
  // searches, not another return-only request.
  db.exec("UPDATE flight_price SET fetched_at = datetime('now', '-7 days')");
  const cachedSummary = await runFlightRefresh({
    db,
    providerNames: ["serpapi"],
    originGroupIds: ["ch"],
    searchProvider,
    delay: async () => {},
  });
  assert.equal(cachedSummary.complete, true);
  assert.equal(cachedSummary.returnCacheHits, 1);
  assert.equal(cachedSummary.returnCellsReused, 1);
  assert.equal(cachedSummary.searched, 2);
  assert.equal(cachedSummary.broadSearches, 2);
  assert.equal(cachedSummary.targetedRetries, 0);
  assert.equal(calls.length, 5);
  assert.ok(calls.slice(3).every((call) => call.originIds === "BSL" && call.returnDate != null));
  db.close();
});
